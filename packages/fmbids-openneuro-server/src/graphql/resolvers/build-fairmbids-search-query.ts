/**
 * Compile FAIR m-BIDS subject search input into Elasticsearch query DSL
 * for the fairmbids-subjects index (one document per subject, nested sessions).
 */

interface Range {
  gte?: number
  lte?: number
}

export interface SessionPredicate {
  sessionId?: string
  order?: Range
  relativeDay?: Range
  modalitiesAll?: string[]
  modalitiesAny?: string[]
}

export interface Transition {
  from: SessionPredicate
  to: SessionPredicate
  minDeltaDays?: number
  maxDeltaDays?: number
}

export interface FairMBidsFilter {
  subject?: { datasetIds?: string[]; sex?: string[]; age?: Range; groups?: string[] }
  longitudinal?: {
    minSessions?: number
    maxSessions?: number
    minSpanDays?: number
    maxSpanDays?: number
    hasSessions?: SessionPredicate[]
    missingSessions?: SessionPredicate[]
    transition?: Transition
  }
  multimodal?: {
    anywhereAll?: string[]
    anywhereAny?: string[]
    sameSessionAll?: string[]
    distinctSessions?: string[]
    everySessionAll?: string[]
  }
  repeatedModality?: { modality: string; minSessions: number }
  completeness?: { required: ("AGE" | "SEX" | "SESSION_TIME" | "MODALITY")[] }
  and?: FairMBidsFilter[]
  or?: FairMBidsFilter[]
  not?: FairMBidsFilter
}

const lower = (values: string[]) => values.map((v) => v.toLowerCase())

const range = (field: string, gte?: number, lte?: number) =>
  gte == null && lte == null ? [] : [{ range: { [field]: { gte, lte } } }]

const allTerms = (field: string, values: string[]) => ({
  terms_set: {
    [field]: {
      terms: lower(values),
      minimum_should_match_script: { source: "params.num_terms" },
    },
  },
})

const nestedSession = (query: object, innerHits?: string) => ({
  nested: {
    path: "sessions",
    query,
    ...(innerHits && {
      inner_hits: {
        name: innerHits,
        size: 100,
        _source: ["sessions.session_id", "sessions.relative_time_days"],
      },
    }),
  },
})

const modalityCount = (modality: string, gte: number) => ({
  nested: {
    path: "modality_session_counts",
    query: {
      bool: {
        filter: [
          { term: { "modality_session_counts.modality": modality.toLowerCase() } },
          { range: { "modality_session_counts.session_count": { gte } } },
        ],
      },
    },
  },
})

/** Conditions that must hold within one session */
export const sessionQuery = (p: SessionPredicate) => ({
  bool: {
    filter: [
      ...(p.sessionId ? [{ term: { "sessions.session_id": p.sessionId } }] : []),
      ...range("sessions.session_order", p.order?.gte, p.order?.lte),
      ...range("sessions.relative_time_days", p.relativeDay?.gte, p.relativeDay?.lte),
      ...(p.modalitiesAll?.length ? [allTerms("sessions.modalities", p.modalitiesAll)] : []),
      ...(p.modalitiesAny?.length
        ? [{ terms: { "sessions.modalities": lower(p.modalitiesAny) } }]
        : []),
    ],
  },
})

const timed = (p: SessionPredicate) => {
  const q = sessionQuery(p)
  q.bool.filter.push({ exists: { field: "sessions.relative_time_days" } } as never)
  return q
}

const completenessFlags = {
  AGE: "has_age",
  SEX: "has_sex",
  SESSION_TIME: "has_session_time",
  MODALITY: "has_modality",
}

/**
 * Two modalities in different sessions. True exactly when both occur and either
 * some session has one without the other, or one of them occurs in 2+ sessions.
 */
const distinctSessions = ([a, b]: string[]) => ({
  bool: {
    filter: [allTerms("modality_set", [a, b])],
    should: [
      nestedSession({ bool: { filter: [allTerms("sessions.modalities", [a])], must_not: [allTerms("sessions.modalities", [b])] } }),
      nestedSession({ bool: { filter: [allTerms("sessions.modalities", [b])], must_not: [allTerms("sessions.modalities", [a])] } }),
      modalityCount(a, 2),
      modalityCount(b, 2),
    ],
    minimum_should_match: 1,
  },
})

/**
 * @param top transition needs result post-processing, so it is only allowed at the top level
 */
export function buildFairMBidsQuery(filter: FairMBidsFilter, top = true) {
  const filters = []
  const mustNot = []
  const { subject, longitudinal: lon, multimodal: mm } = filter
  if (subject?.datasetIds?.length) filters.push({ terms: { dataset_id: subject.datasetIds } })
  if (subject?.sex?.length) filters.push({ terms: { "demographics.sex": subject.sex } })
  if (subject?.groups?.length) filters.push({ terms: { "demographics.group": subject.groups } })
  filters.push(...range("demographics.age", subject?.age?.gte, subject?.age?.lte))
  filters.push(...range("session_count", lon?.minSessions, lon?.maxSessions))
  filters.push(...range("span_days", lon?.minSpanDays, lon?.maxSpanDays))
  for (const p of lon?.hasSessions || []) filters.push(nestedSession(sessionQuery(p)))
  for (const p of lon?.missingSessions || []) mustNot.push(nestedSession(sessionQuery(p)))
  if (lon?.transition) {
    if (!top) throw new Error("transition is only supported at the top level of a filter")
    const t = lon.transition
    if (t.minDeltaDays != null && t.maxDeltaDays != null && t.minDeltaDays > t.maxDeltaDays) {
      throw new Error("transition minDeltaDays must not exceed maxDeltaDays")
    }
    filters.push(nestedSession(timed(t.from), "from"), nestedSession(timed(t.to), "to"))
  }
  if (mm?.anywhereAll?.length) filters.push(allTerms("modality_set", mm.anywhereAll))
  if (mm?.anywhereAny?.length) filters.push({ terms: { modality_set: lower(mm.anywhereAny) } })
  if (mm?.sameSessionAll?.length) {
    filters.push(nestedSession(allTerms("sessions.modalities", mm.sameSessionAll)))
  }
  if (mm?.distinctSessions) {
    // shortcut: two modalities only; 3+ needs a per-subject assignment check
    if (mm.distinctSessions.length !== 2 || lower(mm.distinctSessions)[0] === lower(mm.distinctSessions)[1]) {
      throw new Error("distinctSessions takes exactly two different modalities")
    }
    filters.push(distinctSessions(mm.distinctSessions))
  }
  if (mm?.everySessionAll?.length) {
    mustNot.push(nestedSession({ bool: { must_not: [allTerms("sessions.modalities", mm.everySessionAll)] } }))
  }
  if (filter.repeatedModality) {
    filters.push(modalityCount(filter.repeatedModality.modality, filter.repeatedModality.minSessions))
  }
  for (const field of filter.completeness?.required || []) {
    filters.push({ term: { [`metadata_flags.${completenessFlags[field]}`]: true } })
  }
  for (const f of filter.and || []) filters.push(buildFairMBidsQuery(f, false))
  if (filter.or?.length) {
    filters.push({
      bool: { should: filter.or.map((f) => buildFairMBidsQuery(f, false)), minimum_should_match: 1 },
    })
  }
  if (filter.not) mustNot.push(buildFairMBidsQuery(filter.not, false))
  return { bool: { filter: filters, must_not: mustNot } }
}

interface InnerHit {
  _source: { session_id: string | null; relative_time_days: number }
}

/** Q4: some "from" session followed by a different "to" session within the day window */
export function verifyTransition(
  innerHits: { from: { hits: { hits: InnerHit[] } }; to: { hits: { hits: InnerHit[] } } },
  t: Transition,
): boolean {
  const min = t.minDeltaDays ?? 0
  const max = t.maxDeltaDays ?? Infinity
  return innerHits.from.hits.hits.some(({ _source: f }) =>
    innerHits.to.hits.hits.some(({ _source: to }) => {
      const delta = to.relative_time_days - f.relative_time_days
      return to.session_id !== f.session_id && delta >= min && delta <= max
    })
  )
}
