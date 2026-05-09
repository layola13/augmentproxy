import { routeAugment } from "./augment-router.ts";
import {
  resetFakeAgentsForTest,
  resetIndexedCommitBlobsetsForTest,
} from "./fake-augment.ts";
import { resetIndexerStateForTest } from "./indexer.ts";
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
    requestLogDir: "",
    indexingMode: "off",
    embedBaseUrl: "",
    embedApiKeys: [],
    embedModel: "",
    embedDimensions: 0,
    qdrantUrl: "",
    qdrantCollection: "",
    indexChunkChars: 0,
    indexChunkOverlap: 0,
    logLevel: "error",
  };
}

function requestContext(path: string, body: JsonObject): RequestContext {
  return {
    requestId: "test-request",
    method: "POST",
    url: new URL(`http://localhost/${path}`),
    path: `/${path}`,
    headers: new Headers({ "content-type": "application/json" }),
    body,
    rawBody: JSON.stringify(body),
  };
}

function cliRequestContext(path: string, body: JsonObject): RequestContext {
  return {
    ...requestContext(path, body),
    headers: new Headers({
      "content-type": "application/json",
      "user-agent": "augment.cli/0.26.0 (commit test)/interactive",
    }),
  };
}

async function withIndexedCommitCache(
  cachePath: string,
  fn: () => Promise<void>,
): Promise<void> {
  const original = Deno.env.get("AUGMENT_INDEXED_COMMITS_CACHE");
  Deno.env.set("AUGMENT_INDEXED_COMMITS_CACHE", cachePath);
  resetIndexedCommitBlobsetsForTest();
  try {
    await fn();
  } finally {
    resetIndexedCommitBlobsetsForTest();
    if (original === undefined) {
      Deno.env.delete("AUGMENT_INDEXED_COMMITS_CACHE");
    } else {
      Deno.env.set("AUGMENT_INDEXED_COMMITS_CACHE", original);
    }
  }
}

async function parseNdjsonResponse(response: Response): Promise<JsonObject[]> {
  const text = await response.text();
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

Deno.test({
  name: "reset fake agents state",
  fn() {
    resetFakeAgentsForTest();
    resetIndexerStateForTest();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test("indexed commits return empty latest blobset for unknown commits", async () => {
  const cachePath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await withIndexedCommitCache(cachePath, async () => {
      const response = await routeAugment(
        testConfig(),
        requestContext("indexed-commits/get-latest-blobset", {
          commit_shas: ["missing-sha"],
        }),
      );
      assertEquals(
        response.headers.get("content-type"),
        "application/x-ndjson; charset=utf-8",
      );
      assertEquals(await parseNdjsonResponse(response), []);
    });
  } finally {
    await Deno.remove(cachePath).catch(() => undefined);
  }
});

Deno.test("indexed commits persist registered blobsets across cache reload", async () => {
  const cachePath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await withIndexedCommitCache(cachePath, async () => {
      const commit = {
        commit_sha: "sha-a",
        commit_time: "2026-05-07T09:17:06.000Z",
      };
      const blobset = {
        checkpoint_id: "checkpoint-a",
        added_blobs: ["blob-a"],
        deleted_blobs: [],
      };

      const registerResponse = await routeAugment(
        testConfig(),
        requestContext("indexed-commits/register-blobset", {
          commit,
          blobs: blobset,
        }),
      );
      assertEquals(await registerResponse.json(), { ok: true });

      resetIndexedCommitBlobsetsForTest();
      const latestResponse = await routeAugment(
        testConfig(),
        requestContext("indexed-commits/get-latest-blobset", {
          commit_shas: ["missing-sha", "sha-a"],
        }),
      );
      assertEquals(
        await parseNdjsonResponse(latestResponse),
        [{ commit_sha: "sha-a", file_infos: [] }],
      );
    });
  } finally {
    await Deno.remove(cachePath).catch(() => undefined);
  }
});

Deno.test("indexed commits expand checkpoint blobsets into file infos", async () => {
  const cachePath = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await withIndexedCommitCache(cachePath, async () => {
      resetIndexerStateForTest();

      await routeAugment(
        {
          ...testConfig(),
          indexingMode: "capture",
        },
        requestContext("batch-upload", {
          blobs: [{
            blob_name: "blob-a",
            path: "/workspace/src/a.ts",
            content: "export const a = 1;\n",
          }, {
            blob_name: "blob-b",
            path: "/workspace/src/b.ts",
            content: "export const b = 2;\n",
          }],
        }),
      );

      const checkpointResponse = await routeAugment(
        {
          ...testConfig(),
          indexingMode: "capture",
        },
        requestContext("checkpoint-blobs", {
          blobs: {
            checkpoint_id: null,
            added_blobs: ["blob-a", "blob-b"],
            deleted_blobs: [],
          },
        }),
      );
      const checkpointBody = await checkpointResponse.json() as JsonObject;
      const checkpointId = checkpointBody.new_checkpoint_id;
      if (typeof checkpointId !== "string" || !checkpointId) {
        throw new Error("expected checkpoint id");
      }

      const registerResponse = await routeAugment(
        testConfig(),
        requestContext("indexed-commits/register-blobset", {
          commit: {
            commit_sha: "sha-expanded",
            commit_time: "2026-05-08T12:00:00.000Z",
          },
          blobs: {
            checkpoint_id: checkpointId,
            added_blobs: [],
            deleted_blobs: [],
          },
        }),
      );
      assertEquals(await registerResponse.json(), { ok: true });

      resetIndexedCommitBlobsetsForTest();
      const latestResponse = await routeAugment(
        testConfig(),
        requestContext("indexed-commits/get-latest-blobset", {
          commit_shas: ["sha-expanded"],
        }),
      );
      assertEquals(
        await parseNdjsonResponse(latestResponse),
        [{
          commit_sha: "sha-expanded",
          file_infos: [
            { blob_name: "blob-a", file_path: "/workspace/src/a.ts" },
            { blob_name: "blob-b", file_path: "/workspace/src/b.ts" },
          ],
        }],
      );
    });
  } finally {
    await Deno.remove(cachePath).catch(() => undefined);
    resetIndexerStateForTest();
  }
});

Deno.test("list-remote-tools preserves request order", async () => {
  const response = await routeAugment(
    testConfig(),
    requestContext("agents/list-remote-tools", {
      tool_id_list: { tool_ids: [21, 0, 26, 8] },
    }),
  );
  const body = await response.json() as JsonObject;
  assertEquals(
    (body.tools as JsonObject[]).map((tool) => tool.remote_tool_id),
    [21, 0, 26, 8],
  );
  assertEquals(
    ((body.tools as JsonObject[])[2].tool_definition as JsonObject).name,
    "spawn-agent",
  );
});

Deno.test("list-remote-tools returns client-compatible remote tool metadata", async () => {
  const response = await routeAugment(
    testConfig(),
    requestContext("agents/list-remote-tools", {
      tool_id_list: { tool_ids: [26] },
    }),
  );
  const body = await response.json() as JsonObject;
  const tool = ((body.tools as JsonObject[])[0]) as JsonObject;
  const toolDefinition = tool.tool_definition as JsonObject;

  assertEquals(tool.remote_tool_id, 26);
  assertEquals(tool.availability_status, 1);
  assertEquals(tool.tool_safety, 2);
  assertEquals(tool.oauth_url, "");
  assertEquals(toolDefinition.name, "spawn-agent");
  assertEquals(toolDefinition.tool_safety, 2);
  assertEquals(typeof toolDefinition.input_schema_json, "string");
});

Deno.test("check-tool-safety returns a concrete safety response", async () => {
  const response = await routeAugment(
    testConfig(),
    requestContext("agents/check-tool-safety", { tool_id: 26 }),
  );
  const body = await response.json() as JsonObject;
  assertEquals(body.tool_id, 26);
  assertEquals(body.is_safe, true);
});

Deno.test("cli find-missing in real mode returns unknown blobs instead of faking completion", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  (globalThis as any).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/collections/test_collection")) {
      return new Response(JSON.stringify({ status: "green" }), { status: 200 });
    }
    if (url.endsWith("/collections/test_collection/points")) {
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }
    if (url.endsWith("/collections/test_collection/points/scroll")) {
      return new Response(
        JSON.stringify({ result: { points: [], next_page_offset: null } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const config = {
      ...testConfig(),
      indexingMode: "real",
      qdrantUrl: "http://qdrant.test",
      qdrantCollection: "test_collection",
      embedDimensions: 3,
    };
    const response = await routeAugment(
      config,
      cliRequestContext("find-missing", {
        model: "",
        mem_object_names: ["blob-a", "blob-b"],
      }),
    );
    const body = await response.json() as JsonObject;
    assertEquals(body.unknown_memory_names, ["blob-a", "blob-b"]);
    assertEquals(body.nonindexed_blob_names, []);
    assertEquals(fetchCalls.includes("GET http://qdrant.test/collections/test_collection"), true);
  } finally {
    (globalThis as any).fetch = originalFetch;
    resetIndexerStateForTest();
  }
});

Deno.test("cli batch-upload in real mode uses embeddings and qdrant", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  (globalThis as any).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "http://embed.test/v1/embeddings") {
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.11, 0.22, 0.33] }] }),
        { status: 200 },
      );
    }
    if (url.endsWith("/collections/test_collection")) {
      return new Response(JSON.stringify({ status: "green" }), { status: 200 });
    }
    if (url.endsWith("/collections/test_collection/points/delete")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url.endsWith("/collections/test_collection/points?wait=true")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const config = {
      ...testConfig(),
      indexingMode: "real",
      embedBaseUrl: "http://embed.test/v1",
      embedModel: "test-embed",
      embedDimensions: 3,
      qdrantUrl: "http://qdrant.test",
      qdrantCollection: "test_collection",
      indexChunkChars: 64,
      indexChunkOverlap: 8,
    };
    const response = await routeAugment(
      config,
      cliRequestContext("batch-upload", {
        blobs: [{
          blob_name: "blob-a",
          path: "/home/vscode/projects/example/a.ts",
          content: "const a = 1;",
        }],
      }),
    );
    const body = await response.json() as JsonObject;
    assertEquals(body.blob_names, ["blob-a"]);
    assertEquals(fetchCalls.includes("POST http://embed.test/v1/embeddings"), true);
    assertEquals(
      fetchCalls.includes("PUT http://qdrant.test/collections/test_collection/points?wait=true"),
      true,
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
    resetIndexerStateForTest();
  }
});

Deno.test("cli checkpoint-blobs in real mode applies real delete flow", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  (globalThis as any).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/collections/test_collection")) {
      return new Response(JSON.stringify({ status: "green" }), { status: 200 });
    }
    if (url.endsWith("/collections/test_collection/points/delete")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const config = {
      ...testConfig(),
      indexingMode: "real",
      qdrantUrl: "http://qdrant.test",
      qdrantCollection: "test_collection",
      embedDimensions: 3,
    };
    const response = await routeAugment(
      config,
      cliRequestContext("checkpoint-blobs", {
        blobs: {
          added_blobs: ["blob-a"],
          deleted_blobs: ["blob-b"],
        },
      }),
    );
    const body = await response.json() as JsonObject;
    assertEquals(typeof body.new_checkpoint_id, "string");
    assertEquals(
      fetchCalls.includes("POST http://qdrant.test/collections/test_collection/points/delete"),
      true,
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
    resetIndexerStateForTest();
  }
});

Deno.test("record request events returns fast success", async () => {
  const response = await routeAugment(
    { ...testConfig(), requestLogDir: "/definitely/not/used" },
    requestContext("record-request-events", {
      events: [{ event: { tool_use_data: { tool_name: "sub-agent-docs" } } }],
    }),
  );
  const body = await response.json() as JsonObject;
  assertEquals(body.ok, true);
});

Deno.test("run-remote-tool returns spawn-agent result", async () => {
  const response = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Create a simple web game",
        workspace_folder: "/home/vscode/projects/webgame",
      }),
    }),
  );
  const body = await response.json() as JsonObject;
  assertEquals(body.status, 1);
  assertEquals(body.status_text, "success");
  assertEquals(body.tool_id, 26);
  assertEquals(body.tool_name, "spawn-agent");
  assertEquals(typeof body.tool_result_message, "string");
  assertEquals(
    (body.tool_output as JsonObject).workspace_folder,
    "/home/vscode/projects/webgame",
  );
  assertEquals(typeof (body.tool_output as JsonObject).agent_id, "string");
});

Deno.test("run-remote-tool generic success uses numeric status enum", async () => {
  const response = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "github-api",
      tool_id: 8,
      tool_input_json: JSON.stringify({
        query: "test",
      }),
    }),
  );
  const body = await response.json() as JsonObject;
  assertEquals(body.status, 1);
  assertEquals(body.status_text, "success");
  assertEquals(body.tool_id, 8);
  assertEquals(body.tool_name, "github-api");
  assertEquals(typeof body.tool_result_message, "string");
});

Deno.test("spawn-agent registers agent for later cloud-agent calls", async () => {
  resetFakeAgentsForTest();
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Create a simple web game",
        workspace_folder: "/home/vscode/projects/webgame",
        agent_definition: JSON.stringify({
          name: "Game Builder",
        }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  const sendResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/send-message", {
      agent_id: agentId,
      message: "continue",
    }),
  );
  const sendBody = await sendResponse.json() as JsonObject;
  const agent = sendBody.agent as JsonObject;

  const messagesResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/get-messages", {
      agent_id: agentId,
    }),
  );
  const messagesBody = await messagesResponse.json() as JsonObject;

  assertEquals(agent.agent_id, agentId);
  assertEquals(agent.agent_name, "Game Builder");
  assertEquals(Array.isArray(agent.capabilities), true);
  assertEquals(
    Array.isArray(messagesBody.messages) ? messagesBody.messages.length : -1,
    1,
  );
});

Deno.test("spawn-agent preserves inferred mode and session metadata", async () => {
  resetFakeAgentsForTest();
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Implement the missing files and save the changes",
        workspace_folder: "/home/vscode/projects/webgame",
        agent_definition: JSON.stringify({
          name: "Code Worker",
          description: "Implementation worker",
        }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  const sendResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/send-message", {
      agent_id: agentId,
      message: "continue",
    }),
  );
  const sendBody = await sendResponse.json() as JsonObject;
  const agent = sendBody.agent as JsonObject;
  const sessionConfig = agent.session_config as JsonObject;
  const capabilities = agent.capabilities as JsonObject[];

  assertEquals(sessionConfig.mode, "code");
  assertEquals(sessionConfig.workspace_folder, "/home/vscode/projects/webgame");
  assertEquals(
    sessionConfig.information_request,
    "Implement the missing files and save the changes",
  );
  assertEquals(
    (sessionConfig.agent_definition as JsonObject).name,
    "Code Worker",
  );
  assertEquals((capabilities[0] as JsonObject).mode, "code");
});

Deno.test("spawn-agent preserves askexpert mode", async () => {
  resetFakeAgentsForTest();
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Ask expert to diagnose why code agents loop",
        workspace_folder: "/home/vscode/projects/augmentproxy",
        agent_definition: JSON.stringify({
          name: "askexpert",
          description: "Expert diagnostic reviewer",
        }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  const sendResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/send-message", {
      agent_id: agentId,
      message: "continue",
    }),
  );
  const sendBody = await sendResponse.json() as JsonObject;
  const agent = sendBody.agent as JsonObject;
  const sessionConfig = agent.session_config as JsonObject;
  const capabilities = agent.capabilities as JsonObject[];

  assertEquals(sessionConfig.mode, "askexpert");
  assertEquals((capabilities[0] as JsonObject).mode, "askexpert");
});

Deno.test("spawn-agent preserves docs mode for system wiki tasks", async () => {
  resetFakeAgentsForTest();
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request:
          "Analyze the system and write Markdown system wiki documentation",
        workspace_folder: "/home/vscode/projects/augmentproxy",
        agent_definition: JSON.stringify({
          name: "docs",
          description: "Documentation writer for system wiki pages",
        }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  const sendResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/send-message", {
      agent_id: agentId,
      message: "continue",
    }),
  );
  const sendBody = await sendResponse.json() as JsonObject;
  const agent = sendBody.agent as JsonObject;
  const sessionConfig = agent.session_config as JsonObject;
  const capabilities = agent.capabilities as JsonObject[];

  assertEquals(sessionConfig.mode, "docs");
  assertEquals((capabilities[0] as JsonObject).mode, "docs");
});

Deno.test("cloud agent create preserves capabilities", async () => {
  const capabilities = [{ tool_id: 26, name: "spawn-agent" }];
  const response = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/create", {
      agent_name: "Writable Agent",
      capabilities,
      session_config: { mode: "code" },
    }),
  );
  const body = await response.json() as JsonObject;
  const agent = body.agent as JsonObject;
  assertEquals(agent.agent_name, "Writable Agent");
  assertEquals(agent.capabilities, capabilities);
  assertEquals((agent.session_config as JsonObject).mode, "code");
  assertEquals(typeof agent.agent_id, "string");
});

Deno.test("cloud agent send-message reuses created agent state", async () => {
  const createResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/create", {
      agent_name: "Reusable Agent",
      capabilities: [{ tool_id: 26, name: "spawn-agent" }],
    }),
  );
  const createBody = await createResponse.json() as JsonObject;
  const createdAgent = createBody.agent as JsonObject;
  const agentId = String(createdAgent.agent_id);

  const sendResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/send-message", {
      agent_id: agentId,
      message: "continue",
    }),
  );
  const sendBody = await sendResponse.json() as JsonObject;
  const sentAgent = sendBody.agent as JsonObject;
  const messagesResponse = await routeAugment(
    testConfig(),
    requestContext("cloud-agents/get-messages", {
      agent_id: agentId,
    }),
  );
  const messagesBody = await messagesResponse.json() as JsonObject;

  assertEquals(sentAgent.agent_id, agentId);
  assertEquals(sentAgent.capabilities, createdAgent.capabilities);
  assertEquals(
    Array.isArray(messagesBody.messages) ? messagesBody.messages.length : -1,
    1,
  );
});
