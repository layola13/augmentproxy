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

Deno.test("str-replace tool node includes flat preview fields for Augment UI", async () => {
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
        );
        const body = await response.json() as JsonObject;
        const input = firstToolInput(body);
        assertEquals(input.path, path);
        assertEquals(input.content, "alpha\nbeta\n");
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});

Deno.test("save-file with relative path is repaired via workspace fallback", async () => {
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
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
  const path = await Deno.makeTempFile({
    dir: "/home/vscode/projects/augmentproxy/proxy",
    prefix: "openai-adapter-",
    suffix: ".txt",
  });
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
          testContext({ path: "/home/vscode/projects/augmentproxy/proxy" }),
        );
        const body = await response.json() as JsonObject;
        assertEquals(hasToolName(body, "save-file"), false);
      },
    );
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
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
