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
