/* eslint-disable no-console */
import crypto from "crypto"
import type { Client as ElasticClient } from "@elastic/elasticsearch"
import { FairMBidsSubjectsIndex } from "./indexes/fairmbids-subjects"
import { indexingToken } from "./auth"

type Row = Record<string, string | undefined>

/** Parse a BIDS TSV, treating "n/a" and empty cells as missing */
export function parseTsv(text: string | null): Row[] {
  if (!text) return []
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim())
  if (!header) return []
  const columns = header.split("\t").map((c) => c.trim())
  return lines.map((line) => {
    const cells = line.split("\t")
    return Object.fromEntries(columns.map((c, i) => {
      const value = cells[i]?.trim()
      return [c, value && value !== "n/a" ? value : undefined]
    }))
  })
}

/** Directory entity of a BIDS path, e.g. ("sub-01/ses-02/eeg/x.edf", "ses") => "ses-02" */
const entity = (path: string, prefix: string): string | undefined =>
  path.split("/").slice(0, -1).find((p) => p.startsWith(`${prefix}-`))

/** Subjects referenced by identifiers.tsv rows */
export const identifierSubjects = (identifiers: string | null): string[] => [
  ...new Set(
    parseTsv(identifiers).map((r) => r.file_path && entity(r.file_path, "sub"))
      .filter(Boolean),
  ),
]

const linkageToken = (gsid: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(gsid).digest("hex")

const DAY = 24 * 60 * 60 * 1000

interface FairMBidsFiles {
  datasetId: string
  snapshotTag: string
  isPublic: boolean
  identifiers: string | null
  participants: string | null
  /** sub-<label>_sessions.tsv contents keyed by participant_id */
  sessions: Record<string, string | null>
}

/**
 * Build one search document per subject listed in identifiers.tsv
 * @param linkageSecret HMAC key for GSId linkage tokens; GSId is not indexed without it
 */
export function buildSubjectDocuments(
  files: FairMBidsFiles,
  linkageSecret?: string,
) {
  const participants = parseTsv(files.participants)
  const bySubject = new Map<string, Row[]>()
  for (const row of parseTsv(files.identifiers)) {
    const subject = row.file_path && entity(row.file_path, "sub")
    if (!subject) continue
    bySubject.set(subject, [...(bySubject.get(subject) || []), row])
  }
  return [...bySubject].map(([participantId, rows]) => {
    // Without ses- directories a BIDS subject has exactly one session
    const sessioned = rows.some((r) => entity(r.file_path, "ses"))
    const sessions = new Map<string | null, Set<string>>()
    for (const row of rows) {
      const sessionId = entity(row.file_path, "ses") || null
      if (sessioned && !sessionId) continue // subject-level files, not observations
      const modalities = sessions.get(sessionId) || new Set<string>()
      if (row.modality) modalities.add(row.modality.toLowerCase())
      sessions.set(sessionId, modalities)
    }
    const times = new Map(
      parseTsv(files.sessions[participantId])
        .filter((r) => r.session_id && !isNaN(Date.parse(r.acq_time)))
        .map((r) => [r.session_id, Date.parse(r.acq_time)]),
    )
    const sessionIds = [...sessions.keys()]
    // Chronology only when every session is timed; labels never imply order
    const timed = sessionIds.every((s) => times.has(s))
    const first = timed ? Math.min(...sessionIds.map((s) => times.get(s))) : 0
    const order = [...sessionIds].sort((a, b) => times.get(a) - times.get(b))
    const sessionDocs = [...sessions].map(([sessionId, modalities]) => ({
      session_id: sessionId,
      modalities: [...modalities],
      ...(timed && {
        session_order: order.indexOf(sessionId) + 1,
        relative_time_days: Math.floor((times.get(sessionId) - first) / DAY),
      }),
    }))
    const modalitySet = [...new Set(sessionDocs.flatMap((s) => s.modalities))]
    const participant = participants.find((p) => p.participant_id === participantId) || {}
    const age = parseFloat(participant.age)
    const gsid = participant.GSId || rows.find((r) => r.GSId)?.GSId
    const days = sessionDocs.map((s) => s.relative_time_days)
    return {
      subject_key: `${files.datasetId}:${participantId}`,
      dataset_id: files.datasetId,
      snapshot_tag: files.snapshotTag,
      public: files.isPublic,
      participant_id: participantId,
      demographics: {
        ...(isFinite(age) && { age }),
        ...(participant.sex && { sex: participant.sex }),
        ...(participant.group && { group: participant.group }),
      },
      session_count: sessionDocs.length,
      ...(timed && { span_days: Math.max(...days) - Math.min(...days) }),
      modality_set: modalitySet,
      sessions: sessionDocs,
      modality_session_counts: modalitySet.map((modality) => ({
        modality,
        session_count: sessionDocs.filter((s) => s.modalities.includes(modality)).length,
      })),
      metadata_flags: {
        has_age: isFinite(age),
        has_sex: Boolean(participant.sex),
        has_session_time: timed,
        has_modality: modalitySet.length > 0,
      },
      ...(gsid && linkageSecret && {
        linkage: { token: linkageToken(gsid, linkageSecret), token_version: "v1" },
      }),
    }
  })
}

/** Read a snapshot file through the API with the indexing token; null when absent */
export async function fetchSnapshotFile(
  datasetId: string,
  tag: string,
  path: string,
): Promise<string | null> {
  const base = process.env.GRAPHQL_URI.replace(/\/graphql$/, "")
  const res = await fetch(
    `${base}/datasets/${datasetId}/snapshots/${tag}/files/${path.split("/").join(":")}`,
    { headers: { Cookie: `accessToken=${indexingToken(process.env.JWT_SECRET)}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.text()
}

/**
 * Replace the FAIR m-BIDS subject documents of one dataset with its latest snapshot.
 * Datasets without identifiers.tsv end up with no subject documents.
 */
export async function indexFairMBidsSubjects(
  elasticClient: ElasticClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasetObj: { id: string; public?: boolean; latestSnapshot?: Record<string, any> },
  fetchFile = fetchSnapshotFile,
) {
  const tag = datasetObj.latestSnapshot?.tag
  const identifiers = tag ? await fetchFile(datasetObj.id, tag, "identifiers.tsv") : null
  const sessions = {}
  for (const sub of identifierSubjects(identifiers)) {
    sessions[sub] = await fetchFile(datasetObj.id, tag, `${sub}/${sub}_sessions.tsv`)
  }
  const docs = identifiers
    ? buildSubjectDocuments({
      datasetId: datasetObj.id,
      snapshotTag: tag,
      isPublic: Boolean(datasetObj.public),
      identifiers,
      participants: await fetchFile(datasetObj.id, tag, "participants.tsv"),
      sessions,
    }, process.env.FAIRMBIDS_LINKAGE_SECRET)
    : []
  if (docs.length) {
    const res = await elasticClient.bulk({
      operations: docs.flatMap((doc) => [
        { index: { _index: FairMBidsSubjectsIndex.name, _id: doc.subject_key } },
        doc,
      ]),
    })
    // bulk reports per-document failures instead of throwing
    if (res.errors) {
      const failed = res.items.find((i) => i.index?.error)
      throw new Error(`${datasetObj.id}: ${JSON.stringify(failed.index.error)}`)
    }
  }
  // Index first, then drop subjects no longer present, so search never sees a gap
  await elasticClient.deleteByQuery({
    index: FairMBidsSubjectsIndex.name,
    conflicts: "proceed",
    query: {
      bool: {
        filter: [{ term: { dataset_id: datasetObj.id } }],
        must_not: [{ ids: { values: docs.map((d) => d.subject_key) } }],
      },
    },
  })
  console.log(`Indexed ${docs.length} FAIR m-BIDS subjects for "${datasetObj.id}"`)
}
