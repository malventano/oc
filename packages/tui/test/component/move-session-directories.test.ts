import { describe, expect, test } from "bun:test"
import { mergeMoveSessionSubdirectories } from "../../src/component/move-session-directories"

const root = { directory: "/root/oc/solidigm" }

describe("move session directories", () => {
  test("includes a child directory that has no session", () => {
    expect(
      mergeMoveSessionSubdirectories({
        roots: [root],
        sessions: [],
        children: ["/root/oc/solidigm/new"],
      }),
    ).toEqual([{ location: "/root/oc/solidigm/new", root }])
  })

  test("keeps known session directories and deduplicates filesystem children", () => {
    expect(
      mergeMoveSessionSubdirectories({
        roots: [root],
        sessions: ["/root/oc/solidigm/known"],
        children: ["/root/oc/solidigm/known", "/root/oc/solidigm/new"],
      }),
    ).toEqual([
      { location: "/root/oc/solidigm/known", root },
      { location: "/root/oc/solidigm/new", root },
    ])
  })

  test("excludes roots, paths outside the root, and the root itself", () => {
    expect(
      mergeMoveSessionSubdirectories({
        roots: [root],
        sessions: [],
        children: ["/root/oc/solidigm", "/root/oc/opencode", "/root/oc/solidigm/child"],
      }),
    ).toEqual([{ location: "/root/oc/solidigm/child", root }])
  })

  test("attributes nested child directories to the deepest matching root", () => {
    const nested = { directory: "/root/oc/solidigm/nested" }
    expect(
      mergeMoveSessionSubdirectories({
        roots: [root, nested],
        sessions: [],
        children: ["/root/oc/solidigm/nested/child"],
      }),
    ).toEqual([{ location: "/root/oc/solidigm/nested/child", root: nested }])
  })
})
