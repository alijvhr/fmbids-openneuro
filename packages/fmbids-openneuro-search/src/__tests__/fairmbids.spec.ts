import { vi } from "vitest"
import {
  buildSubjectDocuments,
  identifierSubjects,
  indexFairMBidsSubjects,
  parseTsv,
} from "../fairmbids"

const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n")

const identifiers = tsv([
  ["GUId-Key", "GSId", "GDId", "modality", "file_path"],
  ["k1", "GSId_a", "GDId-1", "anat", "sub-01/ses-a/anat/sub-01_ses-a_T1w.nii.gz"],
  ["k2", "GSId_a", "GDId-1", "eeg", "sub-01/ses-a/eeg/sub-01_ses-a_task-rest_eeg.edf"],
  ["k3", "GSId_a", "GDId-1", "anat", "sub-01/ses-b/anat/sub-01_ses-b_T1w.nii.gz"],
  ["k4", "GSId_a", "GDId-1", "n/a", "sub-01/sub-01_sessions.tsv"],
  ["k5", "n/a", "GDId-1", "eeg", "sub-02/eeg/sub-02_task-rest_eeg.edf"],
  ["k6", "n/a", "GDId-1", "n/a", "participants.tsv"],
])

const files = {
  datasetId: "ds000001",
  snapshotTag: "1.0.0",
  isPublic: true,
  identifiers,
  participants: tsv([
    ["participant_id", "age", "sex", "group"],
    ["sub-01", "30", "F", "patient"],
    ["sub-02", "n/a", "M", "n/a"],
  ]),
  sessions: {
    "sub-01": tsv([
      ["session_id", "acq_time"],
      ["ses-b", "2020-03-01T00:00:00"],
      ["ses-a", "2020-01-01T00:00:00"],
    ]),
    "sub-02": null,
  },
}

describe("FAIR m-BIDS subject documents", () => {
  it("parses n/a and empty cells as missing", () => {
    expect(parseTsv("a\tb\nn/a\t\n")).toEqual([{ a: undefined, b: undefined }])
  })
  it("lists subjects referenced by identifiers.tsv", () => {
    expect(identifierSubjects(identifiers)).toEqual(["sub-01", "sub-02"])
  })
  it("keeps modalities correlated with their session", () => {
    const [sub01] = buildSubjectDocuments(files)
    expect(sub01.sessions).toEqual([
      { session_id: "ses-a", modalities: ["anat", "eeg"], session_order: 1, relative_time_days: 0 },
      { session_id: "ses-b", modalities: ["anat"], session_order: 2, relative_time_days: 60 },
    ])
    expect(sub01.session_count).toBe(2)
    expect(sub01.span_days).toBe(60)
    expect(sub01.modality_set).toEqual(["anat", "eeg"])
    expect(sub01.modality_session_counts).toEqual([
      { modality: "anat", session_count: 2 },
      { modality: "eeg", session_count: 1 },
    ])
  })
  it("orders sessions by acq_time, not by label", () => {
    const docs = buildSubjectDocuments({
      ...files,
      sessions: {
        "sub-01": tsv([
          ["session_id", "acq_time"],
          ["ses-a", "2021-01-01T00:00:00"],
          ["ses-b", "2020-01-01T00:00:00"],
        ]),
      },
    })
    expect(docs[0].sessions.map((s) => s.session_order)).toEqual([2, 1])
  })
  it("treats a subject without ses- directories as one session", () => {
    const sub02 = buildSubjectDocuments(files)[1]
    expect(sub02.sessions).toEqual([{ session_id: null, modalities: ["eeg"] }])
    expect(sub02.session_count).toBe(1)
  })
  it("omits chronology unless every session is timed", () => {
    const docs = buildSubjectDocuments({
      ...files,
      sessions: { "sub-01": tsv([["session_id", "acq_time"], ["ses-a", "2020-01-01"]]) },
    })
    expect(docs[0].span_days).toBeUndefined()
    expect(docs[0].sessions[0].relative_time_days).toBeUndefined()
    expect(docs[0].metadata_flags.has_session_time).toBe(false)
  })
  it("leaves unknown demographics out instead of guessing", () => {
    const sub02 = buildSubjectDocuments(files)[1]
    expect(sub02.demographics).toEqual({ sex: "M" })
    expect(sub02.metadata_flags).toEqual({
      has_age: false,
      has_sex: true,
      has_session_time: false,
      has_modality: true,
    })
  })
  it("indexes GSId only as an HMAC token, and only with a secret", () => {
    expect(buildSubjectDocuments(files)[0]).not.toHaveProperty("linkage")
    const [sub01, sub02] = buildSubjectDocuments(files, "secret")
    expect(sub01.linkage.token).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(sub01)).not.toContain("GSId_a")
    expect(sub02).not.toHaveProperty("linkage")
  })
  it("indexes nothing for a dataset without identifiers.tsv", async () => {
    const elastic = { bulk: vi.fn(), deleteByQuery: vi.fn() }
    await indexFairMBidsSubjects(
      elastic as never,
      { id: "ds000002", latestSnapshot: { tag: "1.0.0" } },
      async () => null,
    )
    expect(elastic.bulk).not.toHaveBeenCalled()
    expect(elastic.deleteByQuery).toHaveBeenCalled()
  })
})
