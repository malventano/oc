import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"

import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: SessionV1.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): SessionV1.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("stall-guard stallTrimAt trims the model request but not the stored text (2026-09-01)", async () => {
    // The stall guard now marks its de-poison trim point in metadata instead
    // of truncating the shared part, so the TUI/DB retain the FULL text (the
    // evidence of what fired the guard - e.g. the serialized <invoke> tool
    // calls in the B200 session). The MODEL REQUEST must trim at that point
    // so the stale colon/stray-tag/serialized-invoke tail is never re-ingested.
    const parentID = "m-user"
    const msgID = "m-assistant"
    const full =
      "Watchdog is dead. Let me check the runner's log format to find the progress indicator.\n\n" +
      '<invoke name="bash">\n<parameter name="command">timeout 30 ssh ... grep done 2>/dev/null</parameter>\n</invoke>'
    const trimAt = full.indexOf("<invoke")

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "continue" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          {
            ...basePart(msgID, "a1"),
            type: "text",
            text: full,
            metadata: { stallTrimAt: trimAt },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    // The request carries ONLY the trimmed prefix (clean intent before the
    // serialized invoke) - the poisoned tail is absent.
    expect(result).toHaveLength(2)
    const assistant = result[1]
    expect(assistant.role).toBe("assistant")
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    expect(textPart!.text).toBe(full.slice(0, trimAt))
    expect(textPart!.text).not.toContain("<invoke")
    // The FULL text remains on the stored part (TUI/DB evidence intact).
    const storedText = input[1].parts[0] as SessionV1.TextPart
    expect(storedText.text).toBe(full)
    expect(storedText.metadata?.["stallTrimAt"]).toBe(trimAt)
  })

  test("leak-strip: serialized <invoke> matching an executed tool is cropped from the request, kept in storage (2026-09-01)", async () => {
    const parentID = "m-user"
    const msgID = "m-assistant"
    const command = "timeout 30 ssh fgpu@10.100.10.113 'grep DONE /tmp/app.log'"
    const full =
      "Watchdog is dead. Let me check the success counter.\n\n" +
      `<invoke name="bash">\n<parameter name="command">${command}</parameter>\n<parameter name="timeout">45000</parameter>\n</invoke>`
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "continue" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          {
            ...basePart(msgID, "a1"),
            type: "text",
            text: full,
          },
          {
            ...basePart(msgID, "t1"),
            type: "tool" as const,
            tool: "bash",
            callID: "call1",
            state: {
              status: "completed" as const,
              input: { command },
              output: "done=12345",
              time: { start: 0, end: 1 },
            },
          } as unknown as SessionV1.ToolPart,
        ] as SessionV1.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result[1]
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    // The leaked invoke is cropped from the REQUEST; the narration prose remains.
    expect(textPart!.text).toContain("Watchdog is dead")
    expect(textPart!.text).not.toContain("<invoke")
    expect(textPart!.text).not.toContain(command)
    // The tool part (with result) survives.
    // The real (executed) tool call survives in the request.
    expect((assistant.content as any[]).some((c) => c.type === "tool-call" && c.toolName === "bash")).toBe(true)
    // The STORED part keeps the full text with the invoke (evidence intact).
    expect((input[1].parts[0] as SessionV1.TextPart).text).toBe(full)
  })

  test("leak-strip: prose/doc describing a tool-call shape with NO matching executed tool is NOT cropped (2026-09-01)", async () => {
    const parentID = "m-user"
    const msgID = "m-assistant"
    // The user asked what a tool call looks like; the model answers in prose,
    // quoting the format - there is NO matching executed tool part.
    const prose =
      'A bash tool call looks like: <invoke name="bash"><parameter name="command">ls -la</parameter></invoke> - the parser runs it and returns the output.'
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "what does a tool call look like?" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          { ...basePart(msgID, "a1"), type: "text", text: prose },
        ] as SessionV1.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result[1]
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    // The doc example survives verbatim - the model keeps the ability to
    // communicate the tool-call format (writing docs, explaining the issue).
    expect(textPart!.text).toContain("<invoke name=\"bash\">")
    expect(textPart!.text).toContain("ls -la")
  })

  test("leak-strip: invoke matching a DIFFERENT-tool executed part is kept (no false crop)", async () => {
    const parentID = "m-user"
    const msgID = "m-assistant"
    const full =
      'Status checked.\n\n<invoke name="bash">\n<parameter name="command">df -h</parameter>\n</invoke>'
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "continue" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          { ...basePart(msgID, "a1"), type: "text", text: full },
          {
            ...basePart(msgID, "t1"),
            type: "tool" as const,
            tool: "read",
            callID: "call1",
            state: {
              status: "completed" as const,
              input: { filePath: "/some/file" },
              output: "contents",
              time: { start: 0, end: 1 },
            },
          } as unknown as SessionV1.ToolPart,
        ] as SessionV1.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result[1]
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    // bash invoke vs read tool: no name match, so the text copy survives.
    expect(textPart!.text).toContain("<invoke")
  })

  test("loop-guard loopTrimAt trims the request but keeps the stored text (2026-09-01)", async () => {
    const parentID = "m-user"
    const msgID = "m-assistant"
    const full = "lead prose\n\nEditing now:Let me make the edit:*editing*"
    const trimAt = full.indexOf("\n")
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "continue" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          {
            ...basePart(msgID, "a1"),
            type: "text",
            text: full,
            metadata: { loopTrimAt: trimAt },
          },
        ] as SessionV1.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result[1]
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    expect(textPart!.text).toBe("lead prose")
    expect(textPart!.text).not.toContain("Editing")
    // stored part keeps the full looped text
    const stored = input[1].parts[0] as SessionV1.TextPart
    expect(stored.text).toBe(full)
  })

  test("stallTrimAt with no tail leftover still emits the preserved prefix (empty-safe)", async () => {
    const parentID = "m-user"
    const msgID = "m-assistant"
    const full = "clean intent before the fire"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(parentID),
        parts: [
          { ...basePart(parentID, "p1"), type: "text", text: "continue" },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(msgID, parentID),
        parts: [
          {
            ...basePart(msgID, "a1"),
            type: "text",
            text: full,
            metadata: { stallTrimAt: full.length, metadataKey: "unrelated" },
          },
        ] as SessionV1.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result[1]
    const textPart = (assistant.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")
    expect(textPart!.text).toBe("clean intent before the fire")
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "[Compacted summary of the prior conversation]" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderV2.ID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderV2.ID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "example.pdf",
            data: `data:application/pdf;base64,${pdf}`,
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          // model switch: provider metadata stripped but the reasoning part
          // type is preserved (prefix-cache compatibility) - not converted
          // back to text
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "abcd\n[Tool output truncated for compaction: omitted 6 chars]",
            },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<shell_metadata>",
      "User aborted the command",
      "</shell_metadata>",
    ].join("\n")

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new SessionV1.APIError({ message: "boom", isRetryable: true }).toObject() as SessionV1.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new SessionV1.AbortedError({
      message: "aborted",
    }).toObject() as SessionV1.Assistant["error"]

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderV2.ID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under 'bedrock' namespace", async () => {
    // Bedrock signed reasoning is preserved as reasoning metadata, but unlike the
    // direct Anthropic path we do not preserve empty text separators for Bedrock.
    const assistantID = "m-assistant-bedrock"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "tokens in request more than max tokens allowed",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect((result as SessionV1.APIError).data.isRetryable).toBe(true)
    expect((result as SessionV1.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: SessionV1.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as SessionV1.Part[],
  }

  const overflowAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const compactionUser: SessionV1.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as SessionV1.Part[],
  }

  const summaryAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const continueUser: SessionV1.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as SessionV1.Part[],
  }

  test("selects latest messages by creation time when IDs are nonmonotonic", () => {
    const oldUser = { ...userInfo("msg_z_user"), time: { created: 100 } }
    const newUser = { ...userInfo("msg_a_user"), time: { created: 200 } }
    const oldAssistant = {
      ...assistantInfo("msg_z_assistant", oldUser.id),
      time: { created: 300 },
      finish: "stop",
    } as SessionV1.Assistant
    const newAssistant = {
      ...assistantInfo("msg_a_assistant", newUser.id),
      time: { created: 400 },
      finish: "stop",
    } as SessionV1.Assistant

    const state = MessageV2.latest([
      { info: newAssistant, parts: [] },
      { info: oldUser, parts: [] },
      { info: oldAssistant, parts: [] },
      { info: newUser, parts: [] },
    ])

    expect(state.user?.id).toBe(newUser.id)
    expect(state.assistant?.id).toBe(newAssistant.id)
    expect(state.finished?.id).toBe(newAssistant.id)
  })

  test("uses ID as a deterministic tie-breaker for equal creation times", () => {
    const lower = { ...userInfo("msg_a_user"), time: { created: 100 } }
    const higher = { ...userInfo("msg_z_user"), time: { created: 100 } }

    const state = MessageV2.latest([
      { info: higher, parts: [] },
      { info: lower, parts: [] },
    ])

    expect(state.user?.id).toBe(higher.id)
  })

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary surfaces in tasks", () => {
    const newCompactionUser: SessionV1.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", auto: true })
  })

  test("selects compaction and subtask work after the finished boundary by creation time", () => {
    const finished = {
      ...assistantInfo("msg_z_finished", "msg_parent"),
      time: { created: 200 },
      finish: "stop",
    } as SessionV1.Assistant
    const oldTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_z_old"), time: { created: 100 } },
      parts: [{ ...basePart("msg_z_old", "old"), type: "compaction", auto: true }] as SessionV1.Part[],
    }
    const newTask: SessionV1.WithParts = {
      info: { ...userInfo("msg_a_new"), time: { created: 300 } },
      parts: [
        {
          ...basePart("msg_a_new", "new"),
          type: "subtask",
          prompt: "inspect",
          description: "inspect ordering",
          agent: "general",
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([newTask, { info: finished, parts: [] }, oldTask])

    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "subtask", prompt: "inspect" })
  })
})
describe("session.message-v2.filterCompacted epochs", () => {
  const T = MessageID.make("msg_epoch_t")
  const C = MessageID.make("msg_epoch_c")
  const S = MessageID.make("msg_epoch_s")
  const N = MessageID.make("msg_epoch_n")

  // Fresh fixtures per test: the delta filter reassigns msg.parts on the
  // filtered objects, so shared fixtures would leak mutations between tests.
  const makeChain = () => {
    const delta = (messageID: MessageID): SessionV1.Part =>
      ({
        ...basePart(messageID, "pd"),
        type: "text",
        text: "<system-reminder>\nSystem context drift: instructions (AGENTS.md) changed\n</system-reminder>",
        synthetic: true,
        metadata: { epochDelta: true },
      }) as SessionV1.Part
    const tailWithDelta: SessionV1.WithParts = {
      info: { ...userInfo(T), time: { created: 100 } },
      parts: [{ ...basePart(T, "p1"), type: "text", text: "original prompt" } as SessionV1.Part, delta(T)],
    }
    const compactionUser: SessionV1.WithParts = {
      info: { ...userInfo(C), time: { created: 200 } },
      parts: [{ ...basePart(C, "p1"), type: "compaction", auto: true, tail_start_id: T } as SessionV1.Part],
    }
    const summaryAssistant: SessionV1.WithParts = {
      info: {
        ...assistantInfo(S, C),
        time: { created: 300 },
        summary: true,
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [],
    }
    const continueUser: SessionV1.WithParts = {
      info: { ...userInfo(N), time: { created: 400 } },
      parts: [{ ...basePart(N, "p1"), type: "text", text: "continue" } as SessionV1.Part],
    }
    return { tailWithDelta, compactionUser, summaryAssistant, continueUser }
  }

  const hasDelta = (msgs: SessionV1.WithParts[]) =>
    msgs.flatMap((m) => m.parts).some((p) => p.type === "text" && p.metadata?.epochDelta)

  test("epoch deltas survive on a chain without a compaction", () => {
    const { tailWithDelta, continueUser } = makeChain()
    const out = MessageV2.filterCompacted([continueUser, tailWithDelta])
    expect(hasDelta(out)).toBe(true)
  })

  test("post-compaction: deltas from the superseded epoch are dropped from the model chain", () => {
    const { tailWithDelta, compactionUser, summaryAssistant, continueUser } = makeChain()
    const out = MessageV2.filterCompacted([continueUser, summaryAssistant, compactionUser, tailWithDelta])
    // The compaction pair survives (the summary is the new epoch boundary).
    expect(out.some((m) => m.info.id === S)).toBe(true)
    expect(out.some((m) => m.info.id === C)).toBe(true)
    expect(hasDelta(out)).toBe(false)
    const tail = out.find((m) => m.info.id === T)!
    expect(tail.parts.some((p) => p.type === "text" && p.metadata?.epochDelta)).toBe(false)
    expect(tail.parts.some((p) => p.type === "text" && p.text === "original prompt")).toBe(true)
  })

  test("the compaction turn itself still sees the deltas (no newer summary yet)", () => {
    const { tailWithDelta, compactionUser } = makeChain()
    const out = MessageV2.filterCompacted([compactionUser, tailWithDelta])
    expect(hasDelta(out)).toBe(true)
  })

  test("an aborted summary does not advance the epoch-delta strip boundary", () => {
    const { tailWithDelta, compactionUser, summaryAssistant, continueUser } = makeChain()
    // A live-epoch delta rides a user message AFTER the last completed
    // summary but BEFORE an aborted finalize (summary:true + error, no
    // finish - the user cancelled the retain selection). The aborted
    // finalize must not move the boundary past the delta: counting it
    // strips the delta mid-chain and the request diverges from the cached
    // prefix (full prefix miss on the next compaction prompt submission).
    const deltaUser: SessionV1.WithParts = {
      info: { ...userInfo("msg_epoch_delta_user"), time: { created: 350 } },
      parts: [
        { ...basePart("msg_epoch_delta_user", "p1"), type: "text", text: "mid" } as SessionV1.Part,
        {
          ...basePart("msg_epoch_delta_user", "pd"),
          type: "text",
          text: "<system-reminder>\nSystem context drift: instructions (AGENTS.md) changed\n</system-reminder>",
          synthetic: true,
          metadata: { epochDelta: true },
        } as SessionV1.Part,
      ],
    }
    const abortedSummary: SessionV1.WithParts = {
      info: {
        ...assistantInfo(MessageID.make("msg_epoch_aborted"), C),
        time: { created: 450 },
        summary: true,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      } as SessionV1.Assistant,
      parts: [],
    }
    const out = MessageV2.filterCompacted([
      abortedSummary,
      continueUser,
      deltaUser,
      summaryAssistant,
      compactionUser,
      tailWithDelta,
    ])
    expect(
      out
        .find((m) => m.info.id === "msg_epoch_delta_user")!
        .parts.some((p) => p.type === "text" && p.metadata?.epochDelta),
    ).toBe(true)
  })

  test("undo past the compaction restores the delta parts (boundary reverts)", () => {
    const { tailWithDelta, continueUser } = makeChain()
    const out = MessageV2.filterCompacted([continueUser, tailWithDelta])
    expect(hasDelta(out)).toBe(true)
  })

  test("multi-compaction: only the newest epoch's deltas reach the model", () => {
    const { tailWithDelta, compactionUser, summaryAssistant, continueUser } = makeChain()
    // Second pair: c2/s2 over a tail starting at the FIRST tail message; the
    // older pair (c1/s1) then sits inside the retained tail, and its epoch's
    // delta (on tailWithDelta) plus any pre-s2 delta must be dropped while
    // the post-s2 delta (on continueUser) stays.
    const C2 = MessageID.make("msg_epoch_c2")
    const S2 = MessageID.make("msg_epoch_s2")
    const deltaOnContinue = ({
      ...basePart(N, "pd2"),
      type: "text",
      text: "<system-reminder>\nSystem context drift: skills changed\n</system-reminder>",
      synthetic: true,
      metadata: { epochDelta: true },
    }) as SessionV1.Part
    // The current-epoch delta rides a message AFTER s2 (chronological).
    const newestUser: SessionV1.WithParts = {
      info: { ...userInfo("msg_epoch_z"), time: { created: 700 } },
      parts: [{ ...basePart("msg_epoch_z", "p1"), type: "text", text: "newest" } as SessionV1.Part, deltaOnContinue],
    }
    const compactionUser2: SessionV1.WithParts = {
      info: { ...userInfo(C2), time: { created: 500 } },
      parts: [{ ...basePart(C2, "p1"), type: "compaction", auto: true, tail_start_id: T } as SessionV1.Part],
    }
    const summaryAssistant2: SessionV1.WithParts = {
      info: {
        ...assistantInfo(S2, C2),
        time: { created: 600 },
        summary: true,
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [],
    }
    const newestUser2: SessionV1.WithParts = {
      info: { ...userInfo("msg_epoch_z2"), time: { created: 800 } },
      parts: [{ ...basePart("msg_epoch_z2", "p1"), type: "text", text: "newest2" } as SessionV1.Part],
    }
    const out = MessageV2.filterCompacted([
      newestUser,
      summaryAssistant2,
      compactionUser2,
      summaryAssistant,
      compactionUser,
      tailWithDelta,
    ])
    expect(out.some((m) => m.info.id === S2)).toBe(true)
    expect(out.some((m) => m.info.id === S)).toBe(true) // older pair retained in the tail
    // The pre-s2 deltas are dropped; the post-s2 delta (on the newest
    // message, after s2 chronologically) stays.
    expect(out.find((m) => m.info.id === T)!.parts.some((p) => p.type === "text" && p.metadata?.epochDelta)).toBe(false)
    expect(
      out
        .find((m) => m.info.id === "msg_epoch_z")!
        .parts.some((p) => p.type === "text" && p.metadata?.epochDelta),
    ).toBe(true)
  })
})

describe("session.message-v2.stripLeakedInvokes", () => {
  test("crops a leaked invoke that matches an executed tool, keeps the rest", () => {
    const cmd = "timeout 30 ssh fgpu@10.100.10.113 'grep DONE /tmp/app.log'"
    const text =
      "Watchdog is dead. Let me check the success counter.\n\n" +
      `<invoke name="bash">\n<parameter name="command">${cmd}</parameter>\n<parameter name="timeout">45000</parameter>\n</invoke>`
    const out = MessageV2.stripLeakedInvokes(text, [{ tool: "bash", input: { command: cmd } }])
    expect(out).toContain("Watchdog is dead")
    expect(out).not.toContain("<invoke")
    expect(out).not.toContain(cmd)
  })

  test("keeps a doc/prose tool-call example when NO executed tool matches", () => {
    const text = 'A bash call looks like: <invoke name="bash"><parameter name="command">ls -la</parameter></invoke>'
    const out = MessageV2.stripLeakedInvokes(text, [])
    expect(out).toBe(text)
  })

  test("crops only matching invokes; non-matching command survives in the same text", () => {
    const cmd1 = "df -h"
    const cmd2 = "ls /tmp"
    const text = `<invoke name="bash"><parameter name="command">${cmd1}</parameter></invoke> done
<invoke name="bash"><parameter name="command">${cmd2}</parameter></invoke>`
    const out = MessageV2.stripLeakedInvokes(text, [{ tool: "bash", input: { command: cmd1 } }])
    expect(out).not.toContain(cmd1)
    expect(out).toContain(cmd2)
    expect(out).toContain("done")
  })

  test("handles the string=true parameter attribute (DSM-formatted command)", () => {
    const cmd = "pgrep -a -f watchdog"
    const text = `<invoke name="bash">\n<parameter name="command" string="true">${cmd}</parameter>\n</invoke>`
    const out = MessageV2.stripLeakedInvokes(text, [{ tool: "bash", input: { command: cmd } }])
    expect(out).toBe("")
  })
})
