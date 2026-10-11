import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import * as LSPServer from "@/lsp/server"
import { Process } from "@/util/process"

function spawnFakeServer() {
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  // Process.spawn mirrors the production LSP launch path and attaches the
  // exited promise the client teardown depends on.
  return {
    process: Process.spawn([process.execPath, serverPath], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    }),
  }
}

describe("LSPClient interop", () => {
  test("handles workspace/workspaceFolders request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "workspace/workspaceFolders",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/registerCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/registerCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("handles client/unregisterCapability request", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/trigger", {
      method: "client/unregisterCapability",
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.connection).toBeDefined()
    await client.shutdown()
  })

  test("initialize does not overclaim unsupported diagnostics capabilities", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const params = await client.connection.sendRequest<any>("test/get-initialize-params", {})
    expect(params.capabilities.workspace.diagnostics.refreshSupport).toBe(false)
    expect(params.capabilities.textDocument.publishDiagnostics.versionSupport).toBe(false)

    await client.shutdown()
  })

  test("workspace/configuration returns one result per requested item", async () => {
    const handle = spawnFakeServer() as any
    const initialization = {
      alpha: {
        beta: 1,
      },
      gamma: true,
    }

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: {
            ...(handle as unknown as LSPServer.Handle),
            initialization,
          },
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const response = await client.connection.sendRequest<any[]>("test/request-configuration", {
      items: [{ section: "alpha" }, { section: "alpha.beta" }, { section: "missing" }, {}],
    })

    expect(response).toEqual([{ beta: 1 }, 1, null, initialization])

    await client.shutdown()
  })

  test("sends ranged didChange for incremental sync servers", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "first\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.notify.open({ path: file })
        await Bun.write(file, "second\nthird\n")
        await client.notify.open({ path: file })

        const change = await client.connection.sendRequest<{
          textDocument: { version: number }
          contentChanges: {
            range?: { start: { line: number; character: number }; end: { line: number; character: number } }
            text: string
          }[]
        }>("test/get-last-change", {})
        expect(change.textDocument.version).toBe(1)
        expect(change.contentChanges).toEqual([
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            text: "second\nthird\n",
          },
        ])

        await client.shutdown()
      },
    })
  })

  test("document mode falls back to push diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        const wait = client.waitForDiagnostics({ path: file, version, mode: "document" })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })
        await wait

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("push diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBe(0)

        await client.shutdown()
      },
    })
  })

  test("document mode accepts matching push diagnostics published before waiting", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.ts")
    await Bun.write(file, "const x = 1\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendNotification("test/publish-diagnostics", {
          uri: pathToFileURL(file).href,
          version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              message: "push diagnostic",
              severity: 1,
            },
          ],
        })

        for (let i = 0; i < 20 && (client.diagnostics.get(file)?.length ?? 0) === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("push diagnostic")

        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "document" })
        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })

  test("document mode waits for pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "DocumentCompilerSemantic" }],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "pull diagnostic",
                severity: 1,
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        await client.waitForDiagnostics({ path: file, version, mode: "document" })

        const diagnostics = client.diagnostics.get(file) ?? []
        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.message).toBe("pull diagnostic")

        const count = await client.connection.sendRequest("test/get-diagnostic-request-count", {})
        expect(count).toBeGreaterThan(0)

        await client.shutdown()
      },
    })
  })

  test("document mode does not wait for the slowest pull identifier after current-file diagnostics arrive", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registrations: [{ identifier: "fast" }, { identifier: "slow" }],
          documentDiagnosticsByIdentifier: {
            fast: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "fast diagnostic",
                severity: 1,
              },
            ],
            slow: [],
          },
          documentDelayMsByIdentifier: {
            slow: 2_500,
          },
        })

        const version = await client.notify.open({ path: file })
        await client.connection.sendRequest("test/register-configured-pull-diagnostics", {})
        await new Promise((resolve) => setTimeout(resolve, 100))
        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "document" })

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(client.diagnostics.get(file)?.[0]?.message).toBe("fast diagnostic")
        expect(await client.connection.sendRequest("test/get-diagnostic-request-count", {})).toBeGreaterThan(1)

        await client.shutdown()
      },
    })
  })

  test("full mode includes workspace pull diagnostics", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    const related = path.join(tmp.path, "other.cs")
    await Bun.write(file, "class C {}\n")
    await Bun.write(related, "class D {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [
            { identifier: "DocumentCompilerSemantic" },
            { identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true },
          ],
          documentDiagnosticsByIdentifier: {
            DocumentCompilerSemantic: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "current file",
                severity: 1,
              },
            ],
          },
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [
              {
                uri: pathToFileURL(related).href,
                items: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    message: "workspace file",
                    severity: 1,
                  },
                ],
              },
            ],
          },
        })

        const version = await client.notify.open({ path: file })
        await client.waitForDiagnostics({ path: file, version, mode: "full" })

        expect(client.diagnostics.get(file)?.[0]?.message).toBe("current file")
        expect(client.diagnostics.get(related)?.[0]?.message).toBe("workspace file")

        await client.shutdown()
      },
    })
  })

  test("full mode treats an empty workspace pull response as handled", async () => {
    const handle = spawnFakeServer() as any
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "client.cs")
    await Bun.write(file, "class C {}\n")

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        const client = await LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
        })

        await client.connection.sendRequest("test/configure-pull-diagnostics", {
          registerOn: "didOpen",
          registrations: [{ identifier: "WorkspaceDocumentsAndProject", workspaceDiagnostics: true }],
          workspaceDiagnosticsByIdentifier: {
            WorkspaceDocumentsAndProject: [],
          },
        })

        const version = await client.notify.open({ path: file })
        const started = Date.now()
        await client.waitForDiagnostics({ path: file, version, mode: "full" })

        expect(Date.now() - started).toBeLessThan(1_000)

        await client.shutdown()
      },
    })
  })

  // 0396 repro harness (BUG_TURN_WEDGE_CHILD_COMPLETION): a pending
  // sendRequest must never outlive the server process. vscode-jsonrpc only
  // rejects pending requests when the stdout stream closes, so a pipe held
  // open by a grandchild after the server dies leaves requests pending
  // forever - the wedge signature observed live on 2026-10-10.

  test("rejects a pending request when the server exits cleanly", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    const pending = client.connection.sendRequest("test/silent", {})
    const state = { outcome: "pending" as "rejected" | "resolved" | "pending" }
    pending.then(
      () => {
        state.outcome = "resolved"
      },
      () => {
        state.outcome = "rejected"
      },
    )

    await client.connection.sendNotification("test/exit")
    const started = Date.now()
    while (state.outcome === "pending" && Date.now() - started < 3_000) {
      await Bun.sleep(25)
    }

    expect(state.outcome).toBe("rejected")
    expect(Date.now() - started).toBeLessThan(3_000)

    client.connection.dispose()
    await Process.stop(handle.process)
  })

  test("rejects a pending request when the server dies and a grandchild holds the stdout pipe", async () => {
    const handle = spawnFakeServer() as any

    const client = await withTestInstance({
      directory: process.cwd(),
      fn: (ctx) =>
        LSPClient.create({
          serverID: "fake",
          server: handle as unknown as LSPServer.Handle,
          root: process.cwd(),
          directory: process.cwd(),
          instance: ctx,
        }),
    })

    await client.connection.sendNotification("test/hold-pipe-and-exit", { holdMs: 8_000 })

    const pending = client.connection.sendRequest("test/silent", {})
    const state = { outcome: "pending" as "rejected" | "resolved" | "pending" }
    pending.then(
      () => {
        state.outcome = "resolved"
      },
      () => {
        state.outcome = "rejected"
      },
    )

    const started = Date.now()
    while (state.outcome === "pending" && Date.now() - started < 3_000) {
      await Bun.sleep(25)
    }

    // Desired behavior: the pending request settles shortly after the server
    // process dies, even though the stdout pipe is still held open. Today the
    // request stays pending forever.
    expect(state.outcome).toBe("rejected")

    client.connection.dispose()
    await Process.stop(handle.process)
  })
})
