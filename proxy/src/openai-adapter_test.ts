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
    openaiBaseUrl: "https://example.test/v1",
    openaiApiKey: "test-key",
    openaiModel: "test-model",
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
