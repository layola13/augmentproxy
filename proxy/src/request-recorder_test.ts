import { recordRequest, summarizeRequestBody } from "./request-recorder.ts";
import type { JsonObject, ProxyConfig, RequestContext } from "./types.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Assertion failed\nactual: ${JSON.stringify(actual)}\nexpected: ${
        JSON.stringify(expected)
      }`,
    );
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function testConfig(requestLogDir: string): ProxyConfig {
  return {
    port: 0,
    switchApi: "OPENAI",
    activeChannel: "default",
    expertChannel: "",
    channels: {
      default: {
        baseUrl: "https://example.test/v1",
        apiKeys: ["test-key"],
        model: "test-model",
      },
    },
    modelMapping: {},
    openaiBaseUrl: "https://example.test/v1",
    codexBaseUrl: "https://codex.example.test/v1",
    openaiApiKeys: ["test-key"],
    codexApiKey: "codex-test-key",
    openaiModel: "test-model",
    codexModel: "codex-test-model",
    openaiUserAgent: "test-agent",
    upstreamAppName: "test",
    sanitizeUpstreamPrompts: false,
    augmentModelContextTokens: 128_000,
    augmentModelMaxOutputTokens: 4_096,
    augmentHistoryTailTokens: 16_000,
    augmentHistoryMaxChars: 64_000,
    augmentHistorySummaryPrompt: "",
    fakeAugmentEmail: "test@example.test",
    fakeAugmentUserId: "test-user",
    requestLogDir,
    indexingMode: "off",
    embedBaseUrl: "",
    embedApiKeys: [],
    embedModel: "",
    embedDimensions: 0,
    qdrantUrl: "",
    qdrantCollection: "",
    indexChunkChars: 0,
    indexChunkOverlap: 0,
    logLevel: "debug",
  };
}

function requestContext(body: JsonObject, rawBody?: string): RequestContext {
  return {
    requestId: "test-request",
    method: "POST",
    url: new URL("http://localhost/chat-stream?debug=1"),
    path: "/chat-stream",
    headers: new Headers({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    }),
    body,
    rawBody: rawBody ?? JSON.stringify(body),
  };
}

function sampleChatBody(): JsonObject {
  return {
    conversation_id: "child-conv",
    parent_conversation_id: "parent-conv",
    root_conversation_id: "root-conv",
    turn_id: "turn-1",
    model: "gpt-test",
    path: "/home/vscode/projects/augmentproxy",
    user_guidelines:
      "You are a code implementation sub-agent. Use the available file tools to create and edit files needed for the assigned implementation task.",
    message: "Create docs under /home/vscode/projects/demo/docs.",
    tool_definitions: [
      { name: "view", input_schema: { type: "object" } },
      { tool_definition: { name: "save-file" } },
      { function: { name: "str-replace-editor" } },
    ],
    nodes: [
      {
        id: 1,
        type: 0,
        text_node: { content: "Continue after the failed write." },
      },
      {
        id: 2,
        type: 5,
        tool_use: {
          tool_name: "save-file",
          tool_use_id: "call_save",
          input_json: JSON.stringify({
            path: "/home/vscode/projects/demo/docs/ARCHITECTURE.md",
            file_content: "#".repeat(20_000),
            api_key: "secret-key",
          }),
        },
      },
      {
        id: 3,
        type: 6,
        tool_result_node: {
          tool_use_id: "call_save",
          tool_name: "save-file",
          is_error: true,
          content:
            "Tool call rejected (save-file): File already exists: /home/vscode/projects/demo/docs/ARCHITECTURE.md",
        },
      },
    ],
    chat_history: [
      {
        request_id: "previous-turn",
        request_nodes: [
          {
            type: 6,
            tool_result_node: {
              tool_use_id: "call_patch",
              tool_name: "apply_patch",
              is_error: true,
              content:
                "Error applying patch File not found: src/tools/advanced-tools.ts",
            },
          },
        ],
        response_nodes: [
          {
            type: 5,
            tool_use: {
              tool_name: "apply_patch",
              tool_use_id: "call_patch",
              input_json: JSON.stringify({
                input: "*** Begin Patch\nlarge patch\n*** End Patch",
              }),
            },
          },
        ],
      },
    ],
  };
}

Deno.test("summarizeRequestBody preserves agent, tool names, calls, and errors", () => {
  const summary = summarizeRequestBody(sampleChatBody()) as JsonObject;
  assertEquals(summary.conversation_id, "child-conv");
  assertEquals(summary.parent_conversation_id, "parent-conv");
  assertEquals(summary.root_conversation_id, "root-conv");
  assertEquals(summary.agent_role, "code");

  const tools = summary.tool_definitions as JsonObject;
  assertEquals(tools.count, 3);
  assertEquals(tools.names, ["view", "save-file", "str-replace-editor"]);

  const nodes = summary.nodes as JsonObject;
  const toolUses = nodes.tool_uses as JsonObject[];
  assertEquals(toolUses.length, 1);
  assertEquals(toolUses[0].name, "save-file");
  assertEquals(
    (toolUses[0].args as JsonObject).path,
    "/home/vscode/projects/demo/docs/ARCHITECTURE.md",
  );
  assertEquals(
    (toolUses[0].args as JsonObject).file_content,
    "[STRING:20000 chars]",
  );
  assertEquals((toolUses[0].args as JsonObject).api_key, "[REDACTED]");

  const recentErrors = summary.recent_tool_errors as JsonObject[];
  assertEquals(recentErrors.length, 2);
  assert(
    JSON.stringify(recentErrors).includes(
      "File not found: src/tools/advanced-tools.ts",
    ),
    "expected historical apply_patch error in recent_tool_errors",
  );
  assert(
    JSON.stringify(recentErrors).includes("File already exists"),
    "expected current save-file rejection in recent_tool_errors",
  );
});

Deno.test("recordRequest writes body_summary for large requests without full body", async () => {
  const dir = await Deno.makeTempDir({ prefix: "augmentproxy-recorder-test-" });
  try {
    const body = sampleChatBody();
    const rawBody = JSON.stringify(body) + " ".repeat(60_000);
    await recordRequest(
      testConfig(dir),
      requestContext(body, rawBody),
      "openai-stream-forward",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const days = [...Deno.readDirSync(dir)].filter((entry) =>
      entry.isDirectory
    );
    assertEquals(days.length, 1);
    const files = [...Deno.readDirSync(`${dir}/${days[0].name}`)].filter((
      entry,
    ) => entry.isFile);
    assertEquals(files.length, 1);

    const payload = JSON.parse(
      await Deno.readTextFile(`${dir}/${days[0].name}/${files[0].name}`),
    ) as JsonObject;
    assertEquals(payload.requestId, "test-request");
    assertEquals((payload.headers as JsonObject).authorization, "[REDACTED]");
    assert(
      typeof payload.body === "string" &&
        payload.body.includes("summary recorded"),
      "expected large body marker",
    );

    const summary = payload.body_summary as JsonObject;
    assertEquals(summary.agent_role, "code");
    assertEquals(
      ((summary.tool_definitions as JsonObject).names as string[]).includes(
        "save-file",
      ),
      true,
    );
    assert(
      JSON.stringify(summary).includes("call_save") &&
        JSON.stringify(summary).includes("File already exists"),
      "expected tool call/result summary in large request log",
    );
    assert(
      !JSON.stringify(payload).includes("secret-token") &&
        !JSON.stringify(payload).includes("secret-key"),
      "expected sensitive values to be redacted",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
