import { describe, expect, test } from "bun:test"
import { acceptReadonlyStmt } from "../../src/tool/sessions-query"

describe("sessions-query readonly guard (oc 0260)", () => {
  test("plain reads are accepted", () => {
    expect(acceptReadonlyStmt("SELECT 1")).toBe(true)
    expect(acceptReadonlyStmt("select * from message")).toBe(true)
    expect(acceptReadonlyStmt("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true)
    expect(acceptReadonlyStmt("PRAGMA table_info(message)")).toBe(true)
    expect(acceptReadonlyStmt("EXPLAIN SELECT 1")).toBe(true)
  })

  test("writes are rejected", () => {
    expect(acceptReadonlyStmt("DELETE FROM message")).toBe(false)
    expect(acceptReadonlyStmt("UPDATE message SET data='{}'")).toBe(false)
    expect(acceptReadonlyStmt("INSERT INTO message VALUES (1)")).toBe(false)
    expect(acceptReadonlyStmt("DROP TABLE message")).toBe(false)
  })

  test("leading whitespace/newlines do not fool the guard", () => {
    expect(acceptReadonlyStmt("  \nSELECT 1")).toBe(true)
    expect(acceptReadonlyStmt("\n\n  DELETE FROM message")).toBe(false)
  })

  test("comment-prefixed reads are accepted (the 0259 analysis trip)", () => {
    expect(acceptReadonlyStmt("-- Find a path error\nWITH err AS (SELECT 1) SELECT * FROM err")).toBe(true)
    expect(acceptReadonlyStmt("-- filter rows\nSELECT * FROM message")).toBe(true)
    expect(acceptReadonlyStmt("/* c */ SELECT 1")).toBe(true)
    expect(acceptReadonlyStmt("  -- indent\n  SELECT 1")).toBe(true)
  })

  test("comment-prefixed writes are still rejected (enforcement holds)", () => {
    expect(acceptReadonlyStmt("-- heading\nDELETE FROM message")).toBe(false)
    expect(acceptReadonlyStmt("/* c */ DROP TABLE message")).toBe(false)
    expect(acceptReadonlyStmt("--\nUPDATE message SET data='{}' WHERE 1")).toBe(false)
  })
})
