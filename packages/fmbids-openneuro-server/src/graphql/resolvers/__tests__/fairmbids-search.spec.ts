import { vi } from "vitest"
import Permission from "../../../models/permission"
import {
  fairMBidsLinkedSubjects,
  openCursor,
  readableDatasetsFilter,
  sealCursor,
} from "../fairmbids-search"

vi.mock("ioredis")
vi.mock("../../../elasticsearch/elastic-client.ts")
vi.mock("../../../config.ts")

describe("FAIR m-BIDS search resolvers", () => {
  it("limits anonymous users to public datasets", async () => {
    expect(await readableDatasetsFilter(null, null)).toEqual({
      bool: { should: [{ term: { public: true } }, { terms: { dataset_id: [] } }], minimum_should_match: 1 },
    })
  })
  it("adds datasets the user holds a permission on", async () => {
    vi.spyOn(Permission, "find").mockResolvedValue([{ datasetId: "ds000002" }] as never)
    const filter = await readableDatasetsFilter("user", { admin: false } as never)
    expect(filter).toHaveProperty("bool.should.1.terms.dataset_id", ["ds000002"])
  })
  it("lets admins read everything", async () => {
    expect(await readableDatasetsFilter("admin", { admin: true } as never)).toEqual({ match_all: {} })
  })
  it("round-trips sealed linkage cursors and rejects tampering", () => {
    const cursor = sealCursor({ token: "abc" }, "secret")
    expect(cursor).not.toContain("abc")
    expect(openCursor(cursor, "secret")).toEqual({ token: "abc" })
    expect(() => openCursor(cursor, "other")).toThrow()
  })
  it("refuses linkage when disabled or for non-admins", async () => {
    delete process.env.FAIRMBIDS_LINKAGE_SECRET
    await expect(fairMBidsLinkedSubjects(null, {}, { user: "a", userInfo: { admin: true } } as never))
      .rejects.toThrow("disabled")
    process.env.FAIRMBIDS_LINKAGE_SECRET = "secret"
    await expect(fairMBidsLinkedSubjects(null, {}, { user: "a", userInfo: { admin: false } } as never))
      .rejects.toThrow("access")
    delete process.env.FAIRMBIDS_LINKAGE_SECRET
  })
})
