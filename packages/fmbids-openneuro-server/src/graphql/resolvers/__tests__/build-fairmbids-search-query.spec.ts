import { buildFairMBidsQuery, verifyTransition } from "../build-fairmbids-search-query"

const hits = (rows: [string | null, number][]) => ({
  hits: { hits: rows.map(([session_id, relative_time_days]) => ({ _source: { session_id, relative_time_days } })) },
})

describe("buildFairMBidsQuery()", () => {
  it("returns an empty bool for an empty filter", () => {
    expect(buildFairMBidsQuery({})).toEqual({ bool: { filter: [], must_not: [] } })
  })
  it("keeps same-session modalities inside one nested session clause", () => {
    const { bool } = buildFairMBidsQuery({ multimodal: { sameSessionAll: ["anat", "EEG"] } })
    expect(bool.filter).toEqual([{
      nested: {
        path: "sessions",
        query: {
          terms_set: {
            "sessions.modalities": {
              terms: ["anat", "eeg"],
              minimum_should_match_script: { source: "params.num_terms" },
            },
          },
        },
      },
    }])
  })
  it("matches modalities anywhere on the subject root", () => {
    const { bool } = buildFairMBidsQuery({ multimodal: { anywhereAll: ["anat", "eeg"] } })
    expect(bool.filter[0]).toHaveProperty("terms_set.modality_set.terms", ["anat", "eeg"])
  })
  it("rejects subjects with any session missing a required modality", () => {
    const { bool } = buildFairMBidsQuery({ multimodal: { everySessionAll: ["anat"] } })
    expect(bool.must_not[0]).toHaveProperty("nested.query.bool.must_not")
  })
  it("expresses distinct sessions without post-processing", () => {
    const { bool } = buildFairMBidsQuery({ multimodal: { distinctSessions: ["anat", "eeg"] } })
    expect(bool.filter[0].bool.should).toHaveLength(4)
    expect(bool.filter[0].bool.minimum_should_match).toBe(1)
  })
  it("requires exactly two different modalities for distinct sessions", () => {
    expect(() => buildFairMBidsQuery({ multimodal: { distinctSessions: ["anat"] } })).toThrow()
    expect(() => buildFairMBidsQuery({ multimodal: { distinctSessions: ["eeg", "EEG"] } })).toThrow()
  })
  it("puts missing sessions in must_not", () => {
    const { bool } = buildFairMBidsQuery({
      longitudinal: {
        hasSessions: [{ order: { lte: 1 }, modalitiesAll: ["anat"] }],
        missingSessions: [{ order: { gte: 2 }, modalitiesAll: ["anat"] }],
      },
    })
    expect(bool.filter[0]).toHaveProperty("nested.query.bool.filter.0.range", {
      "sessions.session_order": { gte: undefined, lte: 1 },
    })
    expect(bool.must_not[0]).toHaveProperty("nested.path", "sessions")
  })
  it("uses materialized counts for repeated modalities and session counts", () => {
    const { bool } = buildFairMBidsQuery({
      longitudinal: { minSessions: 3, minSpanDays: 365 },
      repeatedModality: { modality: "EEG", minSessions: 2 },
    })
    expect(bool.filter).toEqual([
      { range: { session_count: { gte: 3, lte: undefined } } },
      { range: { span_days: { gte: 365, lte: undefined } } },
      {
        nested: {
          path: "modality_session_counts",
          query: {
            bool: {
              filter: [
                { term: { "modality_session_counts.modality": "eeg" } },
                { range: { "modality_session_counts.session_count": { gte: 2 } } },
              ],
            },
          },
        },
      },
    ])
  })
  it("compiles completeness and boolean composition", () => {
    const { bool } = buildFairMBidsQuery({
      completeness: { required: ["AGE", "SESSION_TIME"] },
      or: [{ subject: { groups: ["control"] } }, { subject: { groups: ["patient"] } }],
      not: { subject: { sex: ["M"] } },
    })
    expect(bool.filter[0]).toEqual({ term: { "metadata_flags.has_age": true } })
    expect(bool.filter[1]).toEqual({ term: { "metadata_flags.has_session_time": true } })
    expect(bool.filter[2].bool.should).toHaveLength(2)
    expect(bool.must_not[0].bool.filter).toEqual([{ terms: { "demographics.sex": ["M"] } }])
  })
  it("only allows transitions at the top level", () => {
    const transition = { from: { modalitiesAll: ["anat"] }, to: { modalitiesAll: ["eeg"] } }
    expect(() => buildFairMBidsQuery({ not: { longitudinal: { transition } } })).toThrow()
    expect(() => buildFairMBidsQuery({ longitudinal: { transition: { ...transition, minDeltaDays: 9, maxDeltaDays: 1 } } })).toThrow()
    const { bool } = buildFairMBidsQuery({ longitudinal: { transition } })
    expect(bool.filter.map((f) => f.nested.inner_hits.name)).toEqual(["from", "to"])
  })
})

describe("verifyTransition()", () => {
  const t = { from: {}, to: {}, minDeltaDays: 30, maxDeltaDays: 180 }
  it("accepts a later session inside the window", () => {
    expect(verifyTransition({ from: hits([["ses-1", 0]]), to: hits([["ses-2", 90]]) }, t)).toBe(true)
  })
  it("rejects the same session and out-of-window or earlier sessions", () => {
    expect(verifyTransition({ from: hits([["ses-1", 0]]), to: hits([["ses-1", 0]]) }, { ...t, minDeltaDays: 0 })).toBe(false)
    expect(verifyTransition({ from: hits([["ses-1", 0]]), to: hits([["ses-2", 400]]) }, t)).toBe(false)
    expect(verifyTransition({ from: hits([["ses-2", 90]]), to: hits([["ses-1", 0]]) }, t)).toBe(false)
  })
})
