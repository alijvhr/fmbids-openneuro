import crypto from "crypto"
import { getElasticClient } from "../../elasticsearch/elastic-client"
import Permission from "../../models/permission"
import { decodeCursor, encodeCursor } from "./dataset-search"
import { buildFairMBidsQuery, verifyTransition } from "./build-fairmbids-search-query"
import type { FairMBidsFilter } from "./build-fairmbids-search-query"
import type { GraphQLContext } from "../builder"

export const fairMBidsIndex = "fairmbids-subjects"

/** Restrict to datasets the caller may read, inside the query so counts and facets cannot leak */
export const readableDatasetsFilter = async (
  user: string,
  userInfo: GraphQLContext["userInfo"],
) => {
  if (userInfo?.admin) return { match_all: {} }
  const permitted = user ? (await Permission.find({ userId: user })).map((p) => p.datasetId) : []
  return {
    bool: {
      should: [{ term: { public: true } }, { terms: { dataset_id: permitted } }],
      minimum_should_match: 1,
    },
  }
}

const buckets = (agg) =>
  agg.buckets.map((b) => ({ value: String(b.key), count: b.doc_count }))

const subjectNode = (s) => ({
  subjectKey: s.subject_key,
  datasetId: s.dataset_id,
  snapshotTag: s.snapshot_tag,
  participantId: s.participant_id,
  age: s.demographics?.age,
  sex: s.demographics?.sex,
  group: s.demographics?.group,
  sessionCount: s.session_count,
  spanDays: s.span_days,
  modalities: s.modality_set,
  sessions: s.sessions.map((session) => ({
    sessionId: session.session_id,
    sessionOrder: session.session_order,
    relativeTimeDays: session.relative_time_days,
    modalities: session.modalities,
  })),
})

/**
 * FAIR m-BIDS subject search: each result is one dataset-local subject that
 * satisfied every condition at subject or session scope.
 */
export const fairMBidsSubjects = async (
  obj,
  { filter, first = 25, after, facets = false }: {
    filter: FairMBidsFilter
    first?: number
    after?: string
    facets?: boolean
  },
  { user, userInfo }: GraphQLContext,
) => {
  const transition = filter.longitudinal?.transition
  if (transition && facets) {
    throw new Error("facets are not available with a transition filter")
  }
  const query = buildFairMBidsQuery(filter)
  query.bool.filter.push(await readableDatasetsFilter(user, userInfo))
  const size = Math.min(Math.max(first, 1), 100)
  const result = await getElasticClient().search({
    index: fairMBidsIndex,
    size,
    sort: [{ subject_key: "asc" }],
    query,
    search_after: after ? decodeCursor(after) : undefined,
    track_total_hits: true,
    _source: { excludes: ["linkage"] },
    ...(facets && {
      aggs: {
        modalities: { terms: { field: "modality_set", size: 50 } },
        sexes: { terms: { field: "demographics.sex", size: 20 } },
        groups: { terms: { field: "demographics.group", size: 50 } },
        sessionCounts: { terms: { field: "session_count", size: 50 } },
      },
    }),
  })
  const hits = result.hits.hits
  // Elasticsearch cannot compare days across two sessions; check pairs here
  const matches = transition
    ? hits.filter((hit) => verifyTransition(hit.inner_hits as never, transition))
    : hits
  const last = hits[hits.length - 1]
  return {
    edges: matches.map((hit) => ({
      cursor: encodeCursor(hit.sort),
      node: subjectNode(hit._source),
    })),
    pageInfo: {
      // Elasticsearch only counts transition candidates, so the exact count is unknown
      count: transition ? null : (result.hits.total as { value: number }).value,
      endCursor: last ? encodeCursor(last.sort) : null,
      hasNextPage: hits.length === size,
      startCursor: null,
      hasPreviousPage: false,
    },
    facets: facets
      ? Object.fromEntries(
        Object.entries(result.aggregations).map(([k, agg]) => [k, buckets(agg)]),
      )
      : null,
  }
}

const cursorKey = (secret: string) => crypto.createHash("sha256").update(secret).digest()

/** Linkage cursors hold linkage tokens, so they are encrypted rather than base64 encoded */
export const sealCursor = (value: unknown, secret: string) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", cursorKey(secret), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

export const openCursor = (cursor: string, secret: string) => {
  const raw = Buffer.from(cursor, "base64url")
  const decipher = crypto.createDecipheriv("aes-256-gcm", cursorKey(secret), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString())
}

/**
 * Subjects linked across datasets by GSId (Q13), optionally whose datasets
 * together cover modalitiesAll (Q15). Admin only; disabled without a linkage secret.
 */
export const fairMBidsLinkedSubjects = async (
  obj,
  { datasetIds, minDatasets = 2, modalitiesAll = [], first = 25, after }: {
    datasetIds?: string[]
    minDatasets?: number
    modalitiesAll?: string[]
    first?: number
    after?: string
  },
  { user, userInfo }: GraphQLContext,
) => {
  const secret = process.env.FAIRMBIDS_LINKAGE_SECRET
  if (!secret) throw new Error("FAIR m-BIDS subject linkage is disabled")
  if (!userInfo?.admin) throw new Error("You do not have access to FAIR m-BIDS subject linkage")
  const size = Math.min(Math.max(first, 1), 100)
  const result = await getElasticClient().search({
    index: fairMBidsIndex,
    size: 0,
    query: {
      bool: {
        filter: [
          { exists: { field: "linkage.token" } },
          ...(datasetIds?.length ? [{ terms: { dataset_id: datasetIds } }] : []),
        ],
      },
    },
    aggs: {
      linked: {
        composite: {
          size,
          sources: [{ token: { terms: { field: "linkage.token" } } }],
          ...(after && { after: openCursor(after, secret) }),
        },
        aggs: {
          members: {
            top_hits: { size: 100, _source: ["dataset_id", "participant_id", "modality_set"] },
          },
        },
      },
    },
  })
  const linked = result.aggregations.linked as {
    after_key?: unknown
    buckets: { members: { hits: { hits: { _source: Record<string, never> }[] } } }[]
  }
  const required = modalitiesAll.map((m) => m.toLowerCase())
  const groups = linked.buckets
    .map((b) => b.members.hits.hits.map(({ _source: s }) => ({
      datasetId: s.dataset_id,
      participantId: s.participant_id,
      modalities: s.modality_set,
    })))
    .filter((members) =>
      new Set(members.map((m) => m.datasetId)).size >= minDatasets &&
      required.every((r) => members.some((m) => (m.modalities as string[]).includes(r)))
    )
  // Audit without tokens or GSIds
  // eslint-disable-next-line no-console
  console.log(`FAIR m-BIDS linkage query by ${user}: ${groups.length} groups`)
  return {
    edges: groups.map((members) => ({
      // Opaque and response-scoped, so references cannot be correlated across requests
      node: { linkedSubjectRef: `link_${crypto.randomBytes(9).toString("base64url")}`, members },
    })),
    pageInfo: {
      count: null,
      endCursor: linked.after_key ? sealCursor(linked.after_key, secret) : null,
      hasNextPage: linked.buckets.length === size,
      startCursor: null,
      hasPreviousPage: false,
    },
  }
}
