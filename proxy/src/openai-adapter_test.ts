import { forwardAugmentJson, forwardAugmentStream } from "./openai-adapter.ts";
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

function testConfig(): ProxyConfig {
  return {
    port: 0,
    switchApi: "OPENAI",
    openaiBaseUrl: "https://example.test/v1",
    codexBaseUrl: "https://codex.example.test/v1",
    openaiApiKey: "test-key",
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
    requestLogDir: "",
    indexingMode: "off",
    embedBaseUrl: "",
    embedApiKey: "",
    embedModel: "",
    embedDimensions: 0,
    qdrantUrl: "",
    qdrantCollection: "",
    indexChunkChars: 0,
    indexChunkOverlap: 0,
    logLevel: "error",
  };
}

function testContext(body: JsonObject): RequestContext {
  return {
    requestId: "test-request",
    method: "POST",
    url: new URL("http://localhost/chat"),
    path: "/chat",
    headers: new Headers(),
    body,
    rawBody: JSON.stringify(body),
  };
}

function workspaceContext(): JsonObject {
  return { path: "/home/vscode/projects/augmentproxy/proxy" };
}

function ideWorkspaceContext(root: string): JsonObject {
  return {
    nodes: [{
      id: 1,
      type: 4,
      ide_state_node: {
        workspace_folders: [{
          repository_root: root,
          folder_root: root,
        }],
        workspace_folders_unchanged: true,
        current_terminal: {
          terminal_id: 0,
          current_working_directory: root,
        },
      },
    }],
  };
}

function toolDefinitions(): JsonObject[] {
  return [{
    name: "view",
    description: "Read a file or directory",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        type: { type: "string" },
      },
      required: ["path"],
    },
  }];
}

function historyAfterToolResult(content = "Read file result\n"): JsonObject[] {
  return [{
    response_nodes: [{
      id: 1,
      type: 5,
      tool_use: {
        tool_name: "view",
        tool_use_id: "call_view_previous",
        input_json: JSON.stringify({
          path: "/home/vscode/projects/augmentproxy/proxy",
          type: "directory",
        }),
      },
    }],
    request_nodes: [{
      id: 2,
      type: 1,
      tool_result_node: {
        tool_use_id: "call_view_previous",
        content,
      },
    }],
  }];
}

function contextAfterView(path: string): JsonObject {
  return {
    path: "/home/vscode/projects/augmentproxy/proxy",
    chat_history: [{
      response_nodes: [{
        id: 1,
        type: 5,
        tool_use: {
          tool_name: "view",
          tool_use_id: "call_view_previous",
          input_json: JSON.stringify({ path, type: "file" }),
        },
      }],
      request_nodes: [{
        id: 2,
        type: 1,
        tool_result_node: {
          tool_use_id: "call_view_previous",
          content: `Read file: ${path}\nalpha\n`,
        },
      }],
    }],
  };
}

async function withFakeOpenAIMessage(
  message: JsonObject,
  run: () => Promise<void>,
): Promise<void> {
  await withFakeFetch(
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message }],
          usage: { prompt_tokens: 10, completion_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    run,
  );
}

async function withFakeOpenAIStreamToolCall(
  toolCall: JsonObject,
  run: () => Promise<void>,
): Promise<void> {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { tool_calls: [toolCall] },
              }],
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    run,
  );
}

async function withFakeOpenAIStreamToolCalls(
  toolCalls: JsonObject[],
  run: () => Promise<void>,
): Promise<void> {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              choices: [{
                delta: { tool_calls: toolCalls },
              }],
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    run,
  );
}

async function withFakeFetch(
  response: () => Response,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    (() => Promise.resolve(response())) as typeof fetch;
  try {
    await run();
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
}

async function withCaptureFetch(
  response: Response,
  run: (requests: { url: string; headers: Headers; body: JsonObject }[]) => Promise<void>,
): Promise<void> {
  const requests: { url: string; headers: Headers; body: JsonObject }[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as JsonObject,
      });
      return Promise.resolve(response.clone());
    }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
}

function codexConfig(): ProxyConfig {
  return {
    ...testConfig(),
    switchApi: "CODEX",
    openaiBaseUrl: "https://openai.example.test/v1",
    codexBaseUrl: "https://codex.example.test/v1",
    openaiApiKey: "openai-key",
    codexApiKey: "codex-key",
    openaiModel: "openai-model",
    codexModel: "codex-model",
  };
}

async function makeTempTargetPath(suffix = ".txt"): Promise<string> {
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix,
  });
  await Deno.remove(path);
  return path;
}

async function collectStreamObjects(response: Response): Promise<JsonObject[]> {
  const text = await response.text();
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as JsonObject);
}

function firstToolInput(responseBody: JsonObject | JsonObject[]): JsonObject {
  if (Array.isArray(responseBody)) {
    for (const item of responseBody) {
      try {
        return firstToolInput(item);
      } catch {
        // continue scanning stream chunks
      }
    }
    throw new Error(
      `No tool input found in stream objects: ${JSON.stringify(responseBody)}`,
    );
  }
  const nodes = Array.isArray(responseBody.nodes) ? responseBody.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const toolUse = (node as JsonObject).tool_use;
    if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) {
      continue;
    }
    const inputJson = (toolUse as JsonObject).input_json;
    if (typeof inputJson !== "string") continue;
    return JSON.parse(inputJson) as JsonObject;
  }
  throw new Error(
    `No tool input found in response nodes: ${JSON.stringify(responseBody)}`,
  );
}

function toolInputs(responseBody: JsonObject | JsonObject[]): JsonObject[] {
  const outputs: JsonObject[] = [];
  const scan = (value: JsonObject | JsonObject[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const toolUse = (node as JsonObject).tool_use;
      if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) {
        continue;
      }
      const inputJson = (toolUse as JsonObject).input_json;
      if (typeof inputJson !== "string") continue;
      outputs.push(JSON.parse(inputJson) as JsonObject);
    }
  };
  scan(responseBody);
  return outputs;
}

function hasToolName(
  responseBody: JsonObject | JsonObject[],
  toolName: string,
): boolean {
  const scan = (value: JsonObject | JsonObject[]): boolean => {
    if (Array.isArray(value)) {
      return value.some((item) => scan(item));
    }
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const toolUse = (node as JsonObject).tool_use;
      if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) {
        continue;
      }
      if ((toolUse as JsonObject).tool_name === toolName) return true;
    }
    return false;
  };
  return scan(responseBody);
}

function responseTextContains(
  responseBody: JsonObject | JsonObject[],
  needle: string,
): boolean {
  const scan = (value: JsonObject | JsonObject[]): boolean => {
    if (Array.isArray(value)) return value.some((item) => scan(item));
    if (typeof value.text === "string" && value.text.includes(needle)) return true;
    if (
      typeof value.response_text === "string" &&
      value.response_text.includes(needle)
    ) return true;
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      if (typeof (node as JsonObject).content === "string" && ((node as JsonObject).content as string).includes(needle)) {
        return true;
      }
    }
    return false;
  };
  return scan(responseBody);
}

Deno.test("openai switch uses chat completions endpoint and OPENAI credentials", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "openai ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext({ ...workspaceContext(), message: "hello" }),
      );
      const body = await response.json() as JsonObject;
      assertEquals(body.text, "openai ok");
      assertEquals(requests.length, 1);
      assertEquals(requests[0].url, "https://example.test/v1/chat/completions");
      assertEquals(requests[0].headers.get("authorization"), "Bearer test-key");
      assertEquals(requests[0].body.model, "test-model");
      assertEquals(Array.isArray(requests[0].body.messages), true);
    },
  );
});

Deno.test("codex switch uses responses endpoint and CODEX credentials/model", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        id: "resp-json",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "codex ok" }],
        }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      const response = await forwardAugmentJson(
        codexConfig(),
        testContext({ ...workspaceContext(), message: "hello" }),
      );
      const body = await response.json() as JsonObject;
      assertEquals(body.text, "codex ok");
      assertEquals(requests.length, 1);
      assertEquals(requests[0].url, "https://codex.example.test/v1/responses");
      assertEquals(requests[0].headers.get("authorization"), "Bearer codex-key");
      assertEquals(requests[0].body.model, "codex-model");
      assertEquals(Array.isArray(requests[0].body.input), true);
      assertEquals(typeof requests[0].body.instructions, "string");
      assertEquals(requests[0].body.stream, false);
    },
  );
});

Deno.test("codex instructions do not mandate Next Steps final answers", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        id: "resp-json",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      await forwardAugmentJson(
        codexConfig(),
        testContext({
          ...workspaceContext(),
          tool_definitions: toolDefinitions(),
          message: "inspect the project",
        }),
      );
      const instructions = String(requests[0].body.instructions ?? "");
      assertEquals(instructions.includes("Final-answer format is mandatory"), false);
      assertEquals(instructions.includes("Do not omit this section"), false);
      assertEquals(
        instructions.includes("While concrete tool work remains, use tools instead of appending follow-up suggestions"),
        true,
      );
      assertEquals(instructions.includes("Next Steps"), false);
    },
  );
});

Deno.test("openai continuation with recent history tool result requires next tool call", async () => {
  await withCaptureFetch(
    new Response(
      [
        `data: ${
          JSON.stringify({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 8, completion_tokens: 0 },
          })
        }`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
    async (requests) => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext({
          ...workspaceContext(),
          tool_definitions: toolDefinitions(),
          chat_history: historyAfterToolResult(),
          message: "",
        }),
      );
      await collectStreamObjects(response);
      assertEquals(requests[0].body.tool_choice, "required");
      const messagesText = JSON.stringify(requests[0].body.messages);
      assertEquals(messagesText.includes("Continuation control"), true);
    },
  );
});

Deno.test("codex continuation with tool results requires next tool call", async () => {
  await withCaptureFetch(
    new Response(
      [
        `data: ${
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp-stream",
              status: "completed",
              usage: { input_tokens: 8, output_tokens: 0, total_tokens: 8 },
            },
          })
        }`,
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
    async (requests) => {
      const response = await forwardAugmentStream(
        codexConfig(),
        testContext({
          ...workspaceContext(),
          tool_definitions: toolDefinitions(),
          nodes: [{
            id: 1,
            type: 1,
            tool_result_node: {
              tool_use_id: "call_view_previous",
              content: "Read file result\n",
            },
          }],
        }),
      );
      await collectStreamObjects(response);
      assertEquals(requests[0].body.tool_choice, "required");
      const inputText = JSON.stringify(requests[0].body.input);
      assertEquals(inputText.includes("CODEX tool-continuation control"), true);
      assertEquals(inputText.includes("Do not include follow-up suggestions"), true);
      assertEquals(inputText.includes("Next Steps"), false);
    },
  );
});

Deno.test("codex agent task with user text requires first tool call", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        id: "resp-json",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      await forwardAugmentJson(
        codexConfig(),
        testContext({
          ...workspaceContext(),
          mode: "CLI_AGENT",
          tool_definitions: toolDefinitions(),
          nodes: [{
            id: 1,
            type: 0,
            text_node: {
              content: "Implement the macro layer and run tests.",
            },
          }],
        }),
      );
      assertEquals(requests[0].body.tool_choice, "required");
      const inputText = JSON.stringify(requests[0].body.input);
      assertEquals(inputText.includes("CODEX tool-continuation control"), true);
      assertEquals(inputText.includes("Implement the macro layer"), true);
    },
  );
});

Deno.test("openai request strips historical stale tool rejection text", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      await forwardAugmentJson(
        testConfig(),
        testContext({
          ...workspaceContext(),
          tool_definitions: toolDefinitions(),
          chat_history: [{
            response_nodes: [{
              content:
                "Let me write the fix script first.\n\nTool call rejected (save-file): Tool save-file path is outside the allowed scope.",
            }],
          }],
          message: "continue",
        }),
      );
      const messagesText = JSON.stringify(requests[0].body.messages);
      assertEquals(messagesText.includes("Let me write the fix script first."), true);
      assertEquals(messagesText.includes("Tool call rejected"), false);
      assertEquals(messagesText.includes("outside the allowed scope"), false);
    },
  );
});

Deno.test("codex request strips historical assistant Next Steps sections", async () => {
  await withCaptureFetch(
    new Response(
      JSON.stringify({
        id: "resp-json",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async (requests) => {
      await forwardAugmentJson(
        codexConfig(),
        testContext({
          ...workspaceContext(),
          tool_definitions: toolDefinitions(),
          chat_history: [{
            request_nodes: [{
              text_node: { content: "continue implementing" },
            }],
            response_nodes: [{
              content:
                "I will keep working.\n\n### Next Steps\n1. Read the file.\n2. Edit it.\n",
            }],
          }],
          message: "continue",
        }),
      );
      const inputText = JSON.stringify(requests[0].body.input);
      assertEquals(inputText.includes("I will keep working."), true);
      assertEquals(inputText.includes("Read the file."), false);
      assertEquals(inputText.includes("Next Steps"), false);
    },
  );
});

Deno.test("codex json function_call emits Augment tool node", async () => {
  await withFakeFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "resp-tool",
          output: [{
            type: "function_call",
            call_id: "call_view",
            name: "view",
            arguments: JSON.stringify({
              path: "/home/vscode/projects/augmentproxy/proxy",
              type: "directory",
            }),
          }],
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const response = await forwardAugmentJson(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "view"), true);
      const input = firstToolInput(body);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("openai json invalid save-file recovers with view tool", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_openai_bad_save",
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            path: "/tmp/outside.py",
            file_content: "print('bad')\n",
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "save-file"), false);
      assertEquals(hasToolName(body, "view"), true);
      assertEquals(responseTextContains(body, "Tool call rejected"), false);
      const input = firstToolInput(body);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("codex json invalid save-file recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "resp-bad-save",
          output: [{
            type: "function_call",
            call_id: "call_codex_bad_save_json",
            name: "save-file",
            arguments: JSON.stringify({
              path: "/tmp/outside.py",
              file_content: "print('bad')\n",
            }),
          }],
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const response = await forwardAugmentJson(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "save-file"), false);
      assertEquals(hasToolName(body, "view"), true);
      assertEquals(responseTextContains(body, "Tool call rejected"), false);
      const input = firstToolInput(body);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("codex stream parses Responses SSE text and function_call", async () => {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              type: "response.created",
              response: { id: "resp-stream" },
            })
          }`,
          `data: ${
            JSON.stringify({
              type: "response.output_text.delta",
              delta: "codex ",
            })
          }`,
          `data: ${
            JSON.stringify({
              type: "response.output_text.delta",
              delta: "stream",
            })
          }`,
          `data: ${
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_view_stream",
                name: "view",
                arguments: JSON.stringify({
                  path: "/home/vscode/projects/augmentproxy/proxy",
                  type: "directory",
                }),
              },
            })
          }`,
          `data: ${
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp-stream",
                usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
              },
            })
          }`,
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async () => {
      const response = await forwardAugmentStream(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      const final = objects.find((item) => item.done === true);
      assertEquals(final?.response_text, "codex stream");
      assertEquals(hasToolName(objects, "view"), true);
    },
  );
});

Deno.test("openai stream stale rejection text recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  content:
                    "Let me write the fix script first.\n\nTool call rejected (save-file): Tool save-file path is outside the allowed scope.",
                },
              }],
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async () => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      assertEquals(hasToolName(objects, "view"), true);
      assertEquals(responseTextContains(objects, "Tool call rejected"), false);
      const final = objects.find((item) => item.done === true);
      assertEquals(final?.response_text, "Let me write the fix script first.");
      const input = firstToolInput(objects);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("codex stream invalid save-file recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                call_id: "call_codex_bad_save",
                name: "save-file",
                arguments: JSON.stringify({
                  path: "/tmp/outside.py",
                  file_content: "print('bad')\n",
                }),
              },
            })
          }`,
          `data: ${
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp-stream",
                status: "completed",
                usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
              },
            })
          }`,
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async () => {
      const response = await forwardAugmentStream(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      assertEquals(hasToolName(objects, "save-file"), false);
      assertEquals(hasToolName(objects, "view"), true);
      assertEquals(responseTextContains(objects, "Tool call rejected"), false);
      const input = firstToolInput(objects);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("codex json upstream failed recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "resp-failed",
          status: "failed",
          error: { message: "remote model interrupted" },
          usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const response = await forwardAugmentJson(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(response.ok, true);
      assertEquals(hasToolName(body, "view"), true);
      assertEquals(body.recovery_reason, "remote model interrupted");
      const input = firstToolInput(body);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("codex stream upstream failed recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              type: "response.failed",
              response: {
                id: "resp-stream-failed",
                status: "failed",
                error: { message: "remote stream interrupted" },
                usage: { input_tokens: 8, output_tokens: 0, total_tokens: 8 },
              },
            })
          }`,
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async () => {
      const response = await forwardAugmentStream(
        codexConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      assertEquals(hasToolName(objects, "view"), true);
      const final = objects.find((item) => item.done === true);
      assertEquals(final?.recovery_reason, "remote stream interrupted");
      assertEquals(final?.stop_reason, "stop");
      const input = firstToolInput(objects);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("empty upstream stream recovers with view tool", async () => {
  await withFakeFetch(
    () =>
      new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    async () => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      assertEquals(hasToolName(objects, "view"), true);
      const final = objects.find((item) => item.done === true);
      assertEquals(final?.recovery_reason, "stream ended without done marker or content");
      assertEquals(final?.stop_reason, "stop");
    },
  );
});

Deno.test("str-replace without prior view is redirected to file read", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_unread_edit",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "str-replace-editor"), false);
        assertEquals(hasToolName(body, "view"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("str-replace after prior view is allowed", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_read_edit",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "view"), false);
        assertEquals(hasToolName(body, "str-replace-editor"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.old_str_1, "alpha\n");
        assertEquals(input.new_str_1, "beta\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("str-replace relative path is resolved from IDE workspace root", async () => {
  const root = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-ide-root-",
  });
  const nested = `${root}/src/haxe/state`;
  const path = `${nested}/State.hx`;
  await Deno.mkdir(nested, { recursive: true });
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_relative_edit",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path: "src/haxe/state/State.hx",
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({
            ...ideWorkspaceContext(root),
            chat_history: [{
              response_nodes: [{
                id: 1,
                type: 5,
                tool_use: {
                  tool_name: "view",
                  tool_use_id: "call_view_relative_target",
                  input_json: JSON.stringify({ path, type: "file" }),
                },
              }],
              request_nodes: [{
                id: 2,
                type: 1,
                tool_result_node: {
                  tool_use_id: "call_view_relative_target",
                  content: "alpha\n",
                },
              }],
            }],
          }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "str-replace-editor"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(responseTextContains(body, "Tool call rejected"), false);
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("historical relative str-replace is normalized before upstream replay", async () => {
  const root = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-history-root-",
  });
  const nested = `${root}/src/haxe/state`;
  const path = `${nested}/State.hx`;
  await Deno.mkdir(nested, { recursive: true });
  await Deno.writeTextFile(path, "beta\n");
  try {
    await withCaptureFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      async (requests) => {
        await forwardAugmentJson(
          testConfig(),
          testContext({
            ...ideWorkspaceContext(root),
            chat_history: [{
              response_nodes: [{
                id: 1,
                type: 5,
                tool_use: {
                  tool_name: "str-replace-editor",
                  tool_use_id: "call_history_relative_edit",
                  input_json: JSON.stringify({
                    command: "str_replace",
                    path: "src/haxe/state/State.hx",
                    str_replace_entries: [{
                      old_str: "alpha\n",
                      new_str: "beta\n",
                    }],
                  }),
                },
              }],
              request_nodes: [{
                id: 2,
                type: 1,
                tool_result_node: {
                  tool_use_id: "call_history_relative_edit",
                  content: JSON.stringify({
                    path: "src/haxe/state/State.hx",
                    action: "Update",
                  }),
                },
              }],
            }],
            message: "continue",
          }),
        );
        const messagesText = JSON.stringify(requests[0].body.messages);
        assertEquals(messagesText.includes("\"path\":\"src/haxe/state/State.hx\""), false);
        assertEquals(messagesText.includes(path), true);
        assertEquals(messagesText.includes("Tool call rejected"), false);
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("str-replace does not repair missing path to generated sibling", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-edit-sibling-",
  });
  const existing = `${directoryPath}/plan-bevy-input-module.md`;
  const generated = `${directoryPath}/plan-bevy-input-module-2025-02-20.md`;
  await Deno.writeTextFile(existing, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_edit_generated_sibling",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path: generated,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
                old_str_start_line_number: 1,
                old_str_end_line_number: 1,
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(existing)),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "str-replace-editor"), false);
        assertEquals(hasToolName(body, "view"), true);
        assertEquals(responseTextContains(body, "Tool call rejected"), false);
        const input = firstToolInput(body);
        assertEquals(input.path, directoryPath);
        assertEquals(input.type, "directory");
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("str-replace outside scope recovers with view tool without rejection text", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_edit_outside_scope",
        type: "function",
        function: {
          name: "str-replace-editor",
          arguments: JSON.stringify({
            command: "str_replace",
            path: "/tmp/outside.hx",
            str_replace_entries: [{
              old_str: "alpha\n",
              new_str: "beta\n",
            }],
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "str-replace-editor"), false);
      assertEquals(hasToolName(body, "view"), true);
      assertEquals(responseTextContains(body, "Tool call rejected"), false);
      const input = firstToolInput(body);
      assertEquals(input.path, "/home/vscode/projects/augmentproxy/proxy");
      assertEquals(input.type, "directory");
    },
  );
});

Deno.test("stream str-replace without prior view is redirected to file read", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_unread_edit_stream",
        index: 0,
        type: "function",
        function: {
          name: "str-replace-editor",
          arguments: JSON.stringify({
            command: "str_replace",
            path,
            str_replace_entries: [{
              old_str: "alpha\n",
              new_str: "beta\n",
            }],
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "str-replace-editor"), false);
        assertEquals(hasToolName(objects, "view"), true);
        const input = firstToolInput(objects);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream str-replace after prior view is allowed", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_read_edit_stream",
        index: 0,
        type: "function",
        function: {
          name: "str-replace-editor",
          arguments: JSON.stringify({
            command: "str_replace",
            path,
            str_replace_entries: [{
              old_str: "alpha\n",
              new_str: "beta\n",
            }],
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "view"), false);
        assertEquals(hasToolName(objects, "str-replace-editor"), true);
        const input = firstToolInput(objects);
        assertEquals(input.path, path);
        assertEquals(input.old_str_1, "alpha\n");
        assertEquals(input.new_str_1, "beta\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stale str-replace with no effective entries recovers by reading file", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_stale_edit",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "missing\n",
                new_str: "beta\n",
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "str-replace-editor"), false);
        assertEquals(hasToolName(body, "view"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("str-replace tool node includes flat preview fields for Augment UI", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_test",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "alpha\nbeta\n",
                old_str_start_line_number: 1,
                old_str_end_line_number: 1,
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.str_replace_entries, [{
          old_str: "alpha\n",
          new_str: "alpha\nbeta\n",
          old_str_start_line_number: 1,
          old_str_end_line_number: 1,
        }]);
        assertEquals(input.old_str_1, "alpha\n");
        assertEquals(input.new_str_1, "alpha\nbeta\n");
        assertEquals(input.old_str_start_line_number_1, 1);
        assertEquals(input.old_str_end_line_number_1, 1);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream keeps duplicate tool calls with identical arguments", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIStreamToolCalls(
      [
        {
          id: "call_a",
          index: 0,
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
              }],
            }),
          },
        },
        {
          id: "call_b",
          index: 1,
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              command: "str_replace",
              path,
              str_replace_entries: [{
                old_str: "alpha\n",
                new_str: "beta\n",
              }],
            }),
          },
        },
      ],
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const inputs = toolInputs(await collectStreamObjects(response));
        assertEquals(inputs.length, 2);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream keeps separate tool call ids across multiple deltas", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeFetch(
      () =>
        new Response(
          [
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_a",
                        index: 0,
                        type: "function",
                        function: {
                          name: "str-replace-editor",
                          arguments: JSON.stringify({
                            command: "str_replace",
                            path,
                            str_replace_entries: [{
                              old_str: "alpha\n",
                              new_str: "beta\n",
                            }],
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_b",
                        index: 1,
                        type: "function",
                        function: {
                          name: "str-replace-editor",
                          arguments: JSON.stringify({
                            command: "str_replace",
                            path,
                            str_replace_entries: [{
                              old_str: "alpha\n",
                              new_str: "gamma\n",
                            }],
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const chunks = await collectStreamObjects(response);
        let toolIds: string[] = [];
        for (const chunk of chunks) {
          const nodes = Array.isArray(chunk.nodes) ? chunk.nodes : [];
          for (const node of nodes) {
            if (!node || typeof node !== "object" || Array.isArray(node)) continue;
            const toolUse = (node as JsonObject).tool_use;
            if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) {
              continue;
            }
            const id = (toolUse as JsonObject).tool_use_id;
            if (typeof id === "string" && id) toolIds.push(id);
          }
        }
        toolIds = [...new Set(toolIds)];
        assertEquals(toolIds.sort(), ["call_a", "call_b"]);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("streamed str-replace tool node includes flat preview fields for Augment UI", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_test",
        index: 0,
        type: "function",
        function: {
          name: "str-replace-editor",
          arguments: JSON.stringify({
            command: "str_replace",
            path,
            str_replace_entries: [{
              old_str: "alpha\n",
              new_str: "alpha\nbeta\n",
              old_str_start_line_number: 1,
              old_str_end_line_number: 1,
            }],
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const input = firstToolInput(await collectStreamObjects(response));
        assertEquals(input.str_replace_entries, [{
          old_str: "alpha\n",
          new_str: "alpha\nbeta\n",
          old_str_start_line_number: 1,
          old_str_end_line_number: 1,
        }]);
        assertEquals(input.old_str_1, "alpha\n");
        assertEquals(input.new_str_1, "alpha\nbeta\n");
        assertEquals(input.old_str_start_line_number_1, 1);
        assertEquals(input.old_str_end_line_number_1, 1);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("insert tool node infers insert command and includes flat preview fields", async () => {
  const path = await makeTempTargetPath();
  await Deno.writeTextFile(path, "alpha\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_test",
          type: "function",
          function: {
            name: "str-replace-editor",
            arguments: JSON.stringify({
              path,
              insert_line_entries: [{
                insert_line: 1,
                new_str: "beta\n",
              }],
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.command, "insert");
        assertEquals(input.insert_line_entries, [{
          insert_line: 1,
          new_str: "beta\n",
        }]);
        assertEquals(input.insert_line_1, 1);
        assertEquals(input.new_str_1, "beta\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file normalizes file_path alias to path", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              file_path: path,
              content: "alpha\nbeta\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.content, "alpha\nbeta\n");
        assertEquals(input.file_content, "alpha\nbeta\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file accepts client file_content field", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              file_content: "canonical\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.file_content, "canonical\n");
        assertEquals(input.content, "canonical\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file preserves client add_last_line_newline field", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              file_content: "no trailing newline",
              add_last_line_newline: false,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.file_content, "no trailing newline");
        assertEquals(input.add_last_line_newline, false);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file stringifies non-string file_content like client", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              file_content: 42,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.file_content, "42");
        assertEquals(input.content, "42");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file normalizes content aliases to file_content", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              new_content: "aliased\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.file_content, "aliased\n");
        assertEquals(input.content, "aliased\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file coalesces duplicate same-path writes in one batch", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [
          {
            id: "call_save_short",
            type: "function",
            function: {
              name: "save-file",
              arguments: JSON.stringify({
                path,
                file_content: "short\n",
              }),
            },
          },
          {
            id: "call_save_full",
            type: "function",
            function: {
              name: "save-file",
              arguments: JSON.stringify({
                path,
                file_content: "full\ncontent\n",
              }),
            },
          },
        ],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const inputs = toolInputs(await response.json() as JsonObject);
        assertEquals(inputs.length, 1);
        assertEquals(inputs[0].path, path);
        assertEquals(inputs[0].file_content, "full\ncontent\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file to existing file is converted to str-replace-editor", async () => {
  const path = await makeTempTargetPath(".hx");
  await Deno.writeTextFile(
    path,
    'package;\n\nclass Main {\n    static function main() {\n        trace("old");\n    }\n}\n',
  );
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_existing",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              file_content:
                'package;\n\nclass Main {\n    static function main() {\n        trace("new");\n    }\n}\n',
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
        assertEquals(hasToolName(body, "str-replace-editor"), true);
        const input = firstToolInput(body);
        assertEquals(input.command, "str_replace");
        assertEquals(input.path, path);
        assertEquals(String(input.old_str_1).includes('trace("old");'), true);
        assertEquals(String(input.new_str_1).includes('trace("new");'), true);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file to existing file without prior view is redirected to file read", async () => {
  const path = await makeTempTargetPath(".hx");
  await Deno.writeTextFile(path, "old\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_existing_unread",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
              file_content: "new\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
        assertEquals(hasToolName(body, "str-replace-editor"), false);
        assertEquals(hasToolName(body, "view"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("duplicate save-file to existing file keeps final replacement", async () => {
  const path = await makeTempTargetPath(".hx");
  await Deno.writeTextFile(path, "old\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [
          {
            id: "call_save_existing_1",
            type: "function",
            function: {
              name: "save-file",
              arguments: JSON.stringify({
                path,
                file_content: "middle\n",
              }),
            },
          },
          {
            id: "call_save_existing_2",
            type: "function",
            function: {
              name: "save-file",
              arguments: JSON.stringify({
                path,
                file_content: "final\n",
              }),
            },
          },
        ],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const inputs = toolInputs(await response.json() as JsonObject);
        assertEquals(inputs.length, 1);
        assertEquals(inputs[0].command, "str_replace");
        assertEquals(inputs[0].path, path);
        assertEquals(inputs[0].new_str_1, "final\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file with relative path is repaired via workspace fallback", async () => {
  const path = await makeTempTargetPath();
  const fileName = path.split("/").pop() ?? "";
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: fileName,
              content: "patched\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.path, path);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file with generated _new sibling path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-sibling-",
  });
  const existing = `${directoryPath}/plan-bevy-input-module.md`;
  const generated = `${directoryPath}/plan-bevy-input-module_new.md`;
  await Deno.writeTextFile(existing, "existing\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_generated_sibling",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: generated,
              file_content: "new copy\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({ path: directoryPath }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("save-file with generated date sibling path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-date-sibling-",
  });
  const existing = `${directoryPath}/plan-bevy-input-module.md`;
  const generated = `${directoryPath}/plan-bevy-input-module-2025-02-20.md`;
  await Deno.writeTextFile(existing, "existing\n");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_date_sibling",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: generated,
              file_content: "dated copy\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({ path: directoryPath }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("save-file with embedded explanatory path is repaired", async () => {
  const path = await makeTempTargetPath(".py");
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_embedded_path",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: `Let me write the fix script first: ${path}`,
              file_content: "print('ok')\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file without content is rejected", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file with directory path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-dir-",
  });
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_dir",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: directoryPath,
              file_content: "class ShouldNotUseDirectory {}\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext(workspaceContext()),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("save-file with missing extension directory-like path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-parent-",
  });
  const target = `${directoryPath}/src/haxe/utils`;
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_dirlike",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: target,
              file_content: "class ShouldHaveFilename {}\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({ path: directoryPath }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("save-file allows known extensionless filenames", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-extensionless-",
  });
  const target = `${directoryPath}/Makefile`;
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_save_makefile",
          type: "function",
          function: {
            name: "save-file",
            arguments: JSON.stringify({
              path: target,
              file_content: "all:\n\ttrue\n",
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({ path: directoryPath }),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.path, target);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("save-file without path does not fallback to workspace directory", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_save_no_path",
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            file_content: "class MissingPath {}\n",
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "save-file"), false);
    },
  );
});

Deno.test("view path supports markdown/uri/line-suffixed references", async () => {
  const filePath = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
  await Deno.writeTextFile(filePath, "hello\n");
  const workspacePath = "/home/vscode/projects/augmentproxy/proxy";
  const references = [
    `[openai-adapter.ts](${filePath}:1)`,
    `<${filePath}:1>`,
    `${filePath}:1`,
    `${filePath}#L1`,
    `file://${filePath}`,
    `vscode://file${filePath}`,
  ];
  try {
    for (const ref of references) {
      await withFakeOpenAIMessage(
        {
          content: "",
          tool_calls: [{
            id: "call_view",
            type: "function",
            function: {
              name: "view",
              arguments: JSON.stringify({
                path: ref,
                type: "file",
              }),
            },
          }],
        },
        async () => {
          const response = await forwardAugmentJson(
            testConfig(),
            testContext({ path: workspacePath }),
          );
          const body = await response.json() as JsonObject;
          const input = firstToolInput(body);
          assertEquals(input.path, filePath);
        },
      );
    }
  } finally {
    await Deno.remove(filePath).catch(() => undefined);
  }
});

Deno.test("stream distributes anonymous tool fragments across unresolved calls", async () => {
  const pathA = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-a-",
    suffix: ".txt",
  });
  const pathB = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-b-",
    suffix: ".txt",
  });
  await Deno.writeTextFile(pathA, "alpha\n");
  await Deno.writeTextFile(pathB, "beta\n");
  try {
    await withFakeFetch(
      () =>
        new Response(
          [
            // Two unresolved calls with ids but no initial arguments.
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_a",
                        index: 0,
                        type: "function",
                        function: { name: "view", arguments: "" },
                      },
                      {
                        id: "call_b",
                        index: 1,
                        type: "function",
                        function: { name: "view", arguments: "" },
                      },
                    ],
                  },
                }],
              })
            }`,
            // Anonymous fragments should be distributed, not collapsed.
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        type: "function",
                        function: {
                          name: "view",
                          arguments: `{"path":"${pathA}","type":"file"}`,
                        },
                      },
                      {
                        type: "function",
                        function: {
                          name: "view",
                          arguments: `{"path":"${pathB}","type":"file"}`,
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const inputs = toolInputs(await collectStreamObjects(response));
        assertEquals(inputs.length, 2);
        const paths = inputs
          .map((input) => input.path)
          .filter((value): value is string => typeof value === "string")
          .sort();
        assertEquals(paths, [pathA, pathB].sort());
      },
    );
  } finally {
    await Deno.remove(pathA).catch(() => undefined);
    await Deno.remove(pathB).catch(() => undefined);
  }
});

Deno.test("stream keeps repeated single-thread view reads to same file", async () => {
  const filePath = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-view-repeat-",
    suffix: ".txt",
  });
  await Deno.writeTextFile(filePath, "hello\n");
  try {
    await withFakeFetch(
      () =>
        new Response(
          [
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_view_1",
                        index: 0,
                        type: "function",
                        function: {
                          name: "view",
                          arguments: JSON.stringify({
                            path: filePath,
                            type: "file",
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_view_2",
                        index: 1,
                        type: "function",
                        function: {
                          name: "view",
                          arguments: JSON.stringify({
                            path: filePath,
                            type: "file",
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const inputs = toolInputs(await collectStreamObjects(response));
        assertEquals(inputs.length, 2);
        assertEquals(inputs[0].path, filePath);
        assertEquals(inputs[1].path, filePath);
      },
    );
  } finally {
    await Deno.remove(filePath).catch(() => undefined);
  }
});

Deno.test("stream coalesces repeated same-path save-file writes to final content", async () => {
  const path = await makeTempTargetPath();
  try {
    await withFakeFetch(
      () =>
        new Response(
          [
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_save_1",
                        index: 0,
                        type: "function",
                        function: {
                          name: "save-file",
                          arguments: JSON.stringify({
                            path,
                            content: "first\n",
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_save_2",
                        index: 1,
                        type: "function",
                        function: {
                          name: "save-file",
                          arguments: JSON.stringify({
                            path,
                            content: "second\n",
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const inputs = toolInputs(await collectStreamObjects(response));
        assertEquals(inputs.length, 1);
        assertEquals(inputs[0].path, path);
        assertEquals(inputs[0].content, "second\n");
        assertEquals(inputs[0].file_content, "second\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream save-file to existing file is converted to str-replace-editor", async () => {
  const path = await makeTempTargetPath(".hx");
  await Deno.writeTextFile(
    path,
    'package;\n\nclass Main {\n    static function main() {\n        trace("old");\n    }\n}\n',
  );
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_save_existing_stream",
        index: 0,
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            path,
            file_content:
              'package;\n\nclass Main {\n    static function main() {\n        trace("new");\n    }\n}\n',
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(contextAfterView(path)),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "save-file"), false);
        assertEquals(hasToolName(objects, "str-replace-editor"), true);
        const input = firstToolInput(objects);
        assertEquals(input.command, "str_replace");
        assertEquals(input.path, path);
        assertEquals(String(input.old_str_1).includes('trace("old");'), true);
        assertEquals(String(input.new_str_1).includes('trace("new");'), true);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream save-file to existing file without prior view is redirected to file read", async () => {
  const path = await makeTempTargetPath(".hx");
  await Deno.writeTextFile(path, "old\n");
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_save_existing_unread_stream",
        index: 0,
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            path,
            file_content: "new\n",
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "save-file"), false);
        assertEquals(hasToolName(objects, "str-replace-editor"), false);
        assertEquals(hasToolName(objects, "view"), true);
        const input = firstToolInput(objects);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("stream save-file with directory path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-dir-stream-",
  });
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_save_dir_stream",
        index: 0,
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            path: directoryPath,
            file_content: "class ShouldNotUseDirectoryStream {}\n",
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "save-file"), false);
        assertEquals(hasToolName(objects, "view"), true);
        assertEquals(responseTextContains(objects, "Tool call rejected"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream save-file with missing extension directory-like path is rejected", async () => {
  const directoryPath = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-save-dirlike-stream-",
  });
  const target = `${directoryPath}/src/haxe/utils`;
  try {
    await withFakeOpenAIStreamToolCall(
      {
        id: "call_save_dirlike_stream",
        index: 0,
        type: "function",
        function: {
          name: "save-file",
          arguments: JSON.stringify({
            path: target,
            file_content: "class ShouldHaveFilenameStream {}\n",
          }),
        },
      },
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext({ path: directoryPath }),
        );
        const objects = await collectStreamObjects(response);
        assertEquals(hasToolName(objects, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(directoryPath, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream save-file without path does not fallback to workspace directory", async () => {
  await withFakeOpenAIStreamToolCall(
    {
      id: "call_save_no_path_stream",
      index: 0,
      type: "function",
      function: {
        name: "save-file",
        arguments: JSON.stringify({
          file_content: "class MissingPathStream {}\n",
        }),
      },
    },
    async () => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext(workspaceContext()),
      );
      const objects = await collectStreamObjects(response);
      assertEquals(hasToolName(objects, "save-file"), false);
    },
  );
});

Deno.test("stream distributes parallel anonymous save-file fragments across unresolved calls", async () => {
  const pathA = await makeTempTargetPath();
  const pathB = await makeTempTargetPath();
  try {
    await withFakeFetch(
      () =>
        new Response(
          [
            // Two unresolved calls with ids but no initial arguments.
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        id: "call_save_a",
                        index: 0,
                        type: "function",
                        function: { name: "save-file", arguments: "" },
                      },
                      {
                        id: "call_save_b",
                        index: 1,
                        type: "function",
                        function: { name: "save-file", arguments: "" },
                      },
                    ],
                  },
                }],
              })
            }`,
            // Anonymous fragments should be distributed, not collapsed.
            `data: ${
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        type: "function",
                        function: {
                          name: "save-file",
                          arguments: JSON.stringify({
                            path: pathA,
                            file_content: "first\n",
                          }),
                        },
                      },
                      {
                        type: "function",
                        function: {
                          name: "save-file",
                          arguments: JSON.stringify({
                            path: pathB,
                            file_content: "second\n",
                          }),
                        },
                      },
                    ],
                  },
                }],
              })
            }`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      async () => {
        const response = await forwardAugmentStream(
          testConfig(),
          testContext(workspaceContext()),
        );
        const inputs = toolInputs(await collectStreamObjects(response));
        assertEquals(inputs.length, 2);
        const paths = inputs
          .map((input) => input.path)
          .filter((value): value is string => typeof value === "string")
          .sort();
        assertEquals(paths, [pathA, pathB].sort());
        const contents = inputs
          .map((input) => input.file_content)
          .filter((value): value is string => typeof value === "string")
          .sort();
        assertEquals(contents, ["first\n", "second\n"]);
      },
    );
  } finally {
    await Deno.remove(pathA).catch(() => undefined);
    await Deno.remove(pathB).catch(() => undefined);
  }
});

Deno.test("write-process normalizes write_stdin style session_id and chars", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_write_stdin",
        type: "function",
        function: {
          name: "write-process",
          arguments: JSON.stringify({
            session_id: "77126",
            chars: "",
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      const input = firstToolInput(body);
      assertEquals(input.terminal_id, 77126);
      assertEquals(input.input_text, "");
    },
  );
});

Deno.test("launch-process with pipe gets pipefail guard", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_pipe_command",
        type: "function",
        function: {
          name: "launch-process",
          arguments: JSON.stringify({
            command: "haxe -p src -main TestAll --interp 2>&1 | head -30",
            cwd: "/home/vscode/projects/augmentproxy/proxy",
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      const input = firstToolInput(body);
      assertEquals(
        input.command,
        "set -o pipefail; haxe -p src -main TestAll --interp 2>&1 | head -30",
      );
    },
  );
});

Deno.test("repeated failed launch-process recovers by reading diagnostic file", async () => {
  const root = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-failed-launch-",
  });
  const path = `${root}/src/haxe/state/NextState.hx`;
  await Deno.mkdir(`${root}/src/haxe/state`, { recursive: true });
  await Deno.writeTextFile(path, "class NextState {}\n");
  const command = "cd /home/vscode/projects/bevy_haxe && haxe -p src -main TestAll --interp 2>&1";
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_repeat_compile",
          type: "function",
          function: {
            name: "launch-process",
            arguments: JSON.stringify({
              command: `${command} | head -30`,
              cwd: root,
              wait: true,
              max_wait_seconds: 60,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({
            ...ideWorkspaceContext(root),
            chat_history: [{
              response_nodes: [{
                id: 1,
                type: 5,
                tool_use: {
                  tool_name: "launch-process",
                  tool_use_id: "call_failed_compile",
                  input_json: JSON.stringify({
                    command,
                    cwd: root,
                    wait: true,
                    max_wait_seconds: 60,
                  }),
                },
              }],
              request_nodes: [{
                id: 2,
                type: 1,
                tool_result_node: {
                  tool_use_id: "call_failed_compile",
                  content: [
                    "Here are the results from executing the command.",
                    "<return-code>",
                    "0",
                    "</return-code>",
                    "<output>",
                    "src/haxe/state/NextState.hx:21: characters 19-25 : Type not found : States",
                    "",
                    "</output>",
                  ].join("\n"),
                },
              }],
            }],
          }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "launch-process"), false);
        assertEquals(hasToolName(body, "view"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.type, "file");
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("repeated failed launch-process without diagnostic path recovers by reading workspace", async () => {
  const root = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-failed-launch-workspace-",
  });
  const command =
    "cat > /tmp/fix_state.py << 'PYEOF'\nprint('`bad`')\nPYEOF";
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_repeat_backticks",
          type: "function",
          function: {
            name: "launch-process",
            arguments: JSON.stringify({
              command,
              cwd: root,
              wait: true,
              max_wait_seconds: 60,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({
            ...ideWorkspaceContext(root),
            chat_history: [{
              response_nodes: [{
                id: 1,
                type: 5,
                tool_use: {
                  tool_name: "launch-process",
                  tool_use_id: "call_failed_backticks",
                  input_json: JSON.stringify({
                    command,
                    cwd: root,
                    wait: true,
                    max_wait_seconds: 60,
                  }),
                },
              }],
              request_nodes: [{
                id: 2,
                type: 1,
                tool_result_node: {
                  tool_use_id: "call_failed_backticks",
                  content:
                    "Error: Backticks are not allowed in shell commands. Write content to a file first.",
                  is_error: true,
                },
              }],
            }],
          }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "launch-process"), false);
        assertEquals(hasToolName(body, "view"), true);
        const input = firstToolInput(body);
        assertEquals(input.path, root);
        assertEquals(input.type, "directory");
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("successful output mentioning zero failed does not suppress repeated launch-process", async () => {
  const root = await Deno.makeTempDir({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-successful-launch-",
  });
  const command = "deno test --allow-read proxy/src/openai-adapter_test.ts";
  try {
    await withFakeOpenAIMessage(
      {
        content: "",
        tool_calls: [{
          id: "call_repeat_successful_tests",
          type: "function",
          function: {
            name: "launch-process",
            arguments: JSON.stringify({
              command,
              cwd: root,
              wait: true,
              max_wait_seconds: 60,
            }),
          },
        }],
      },
      async () => {
        const response = await forwardAugmentJson(
          testConfig(),
          testContext({
            ...ideWorkspaceContext(root),
            chat_history: [{
              response_nodes: [{
                id: 1,
                type: 5,
                tool_use: {
                  tool_name: "launch-process",
                  tool_use_id: "call_successful_tests",
                  input_json: JSON.stringify({
                    command,
                    cwd: root,
                    wait: true,
                    max_wait_seconds: 60,
                  }),
                },
              }],
              request_nodes: [{
                id: 2,
                type: 1,
                tool_result_node: {
                  tool_use_id: "call_successful_tests",
                  content: [
                    "Here are the results from executing the command.",
                    "<return-code>",
                    "0",
                    "</return-code>",
                    "<output>",
                    "ok | 63 passed | 0 failed (236ms)",
                    "</output>",
                  ].join("\n"),
                },
              }],
            }],
          }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "launch-process"), true);
        const input = firstToolInput(body);
        assertEquals(input.command, command);
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("repeated failed write-process recovers by listing processes", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_repeat_write_process",
        type: "function",
        function: {
          name: "write-process",
          arguments: JSON.stringify({
            terminal_id: 7,
            input_text: "continue\n",
            wait: true,
            max_wait_seconds: 60,
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext({
          ...workspaceContext(),
          chat_history: [{
            response_nodes: [{
              id: 1,
              type: 5,
              tool_use: {
                tool_name: "write-process",
                tool_use_id: "call_failed_write_process",
                input_json: JSON.stringify({
                  terminal_id: 7,
                  input_text: "continue\n",
                  wait: true,
                  max_wait_seconds: 60,
                }),
              },
            }],
            request_nodes: [{
              id: 2,
              type: 1,
              tool_result_node: {
                tool_use_id: "call_failed_write_process",
                content: "Terminal 7 not found.",
                is_error: true,
              },
            }],
          }],
        }),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "write-process"), false);
      assertEquals(hasToolName(body, "list-processes"), true);
      assertEquals(firstToolInput(body), {});
    },
  );
});

Deno.test("write-process normalizes terminal and input aliases", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_write_alias",
        type: "function",
        function: {
          name: "write-process",
          arguments: JSON.stringify({
            terminal: "2",
            input: "continue\n",
          }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      const input = firstToolInput(body);
      assertEquals(input.terminal_id, 2);
      assertEquals(input.input_text, "continue\n");
    },
  );
});

Deno.test("invalid read-process recovers with list-processes without rejection text", async () => {
  await withFakeOpenAIMessage(
    {
      content: "",
      tool_calls: [{
        id: "call_read_process_missing_terminal",
        type: "function",
        function: {
          name: "read-process",
          arguments: JSON.stringify({ wait: false, max_wait_seconds: 1 }),
        },
      }],
    },
    async () => {
      const response = await forwardAugmentJson(
        testConfig(),
        testContext(workspaceContext()),
      );
      const body = await response.json() as JsonObject;
      assertEquals(hasToolName(body, "read-process"), false);
      assertEquals(hasToolName(body, "list-processes"), true);
      assertEquals(responseTextContains(body, "Tool call rejected"), false);
      assertEquals(firstToolInput(body), {});
    },
  );
});

Deno.test("stream keeps repeated write-process writes to same terminal", async () => {
  await withFakeFetch(
    () =>
      new Response(
        [
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [
                    {
                      id: "call_write_1",
                      index: 0,
                      type: "function",
                      function: {
                        name: "write-process",
                        arguments: JSON.stringify({
                          session_id: 10205,
                          chars: "",
                        }),
                      },
                    },
                  ],
                },
              }],
            })
          }`,
          `data: ${
            JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [
                    {
                      id: "call_write_2",
                      index: 1,
                      type: "function",
                      function: {
                        name: "write-process",
                        arguments: JSON.stringify({
                          session_id: 10205,
                          chars: "continue\n",
                        }),
                      },
                    },
                  ],
                },
              }],
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    async () => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext(workspaceContext()),
      );
      const inputs = toolInputs(await collectStreamObjects(response));
      assertEquals(inputs.length, 2);
      assertEquals(inputs[0].terminal_id, 10205);
      assertEquals(inputs[1].terminal_id, 10205);
      assertEquals(inputs[0].input_text, "");
      assertEquals(inputs[1].input_text, "continue\n");
    },
  );
});

Deno.test("stream keeps parallel write-process calls across terminals", async () => {
  await withFakeOpenAIStreamToolCalls(
    [
      {
        id: "call_write_a",
        index: 0,
        type: "function",
        function: {
          name: "write-process",
          arguments: JSON.stringify({
            session_id: 2,
            chars: "",
          }),
        },
      },
      {
        id: "call_write_b",
        index: 1,
        type: "function",
        function: {
          name: "write-process",
          arguments: JSON.stringify({
            session_id: 3,
            chars: "go\n",
          }),
        },
      },
    ],
    async () => {
      const response = await forwardAugmentStream(
        testConfig(),
        testContext(workspaceContext()),
      );
      const inputs = toolInputs(await collectStreamObjects(response));
      assertEquals(inputs.length, 2);
      const terminals = inputs
        .map((input) => input.terminal_id)
        .filter((value): value is number => typeof value === "number")
        .sort((a, b) => a - b);
      assertEquals(terminals, [2, 3]);
      const texts = inputs
        .map((input) => input.input_text)
        .filter((value): value is string => typeof value === "string")
        .sort();
      assertEquals(texts, ["", "go\n"].sort());
    },
  );
});
