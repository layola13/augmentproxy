import { routeAugment } from "./augment-router.ts";
import { forwardAugmentJson, forwardAugmentStream } from "./openai-adapter.ts";
import {
  getAgentUsageStats,
  reportAgentUsage,
  resetFakeAgentsForTest,
} from "./fake-augment.ts";
import type {
  AgentUsageSummary,
  JsonObject,
  ProxyConfig,
  RequestContext,
} from "./types.ts";

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

function requestContext(path: string, body: JsonObject = {}): RequestContext {
  return {
    requestId: "test-request",
    method: body && Object.keys(body).length > 0 ? "POST" : "GET",
    url: new URL(`http://localhost/${path}`),
    path: `/${path}`,
    headers: new Headers({ "content-type": "application/json" }),
    body,
    rawBody: JSON.stringify(body),
  };
}

Deno.test("agent usage stats tracking", async () => {
  resetFakeAgentsForTest();

  // 1. Spawn an agent
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Test agent usage",
        workspace_folder: "/test",
        agent_definition: JSON.stringify({ name: "test-agent" }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  // 2. Initially usage should be zero
  let stats = getAgentUsageStats();
  assertEquals(stats.agents.length, 0); // Not included if zero usage

  // 3. Report usage
  reportAgentUsage(agentId, 100, 50);
  reportAgentUsage(agentId, 200, 150);

  // 4. Verify stats
  stats = getAgentUsageStats();
  assertEquals(stats.agents.length, 1);
  assertEquals(stats.agents[0].agent_id, agentId);
  assertEquals(stats.agents[0].name, "test-agent");
  assertEquals(stats.agents[0].input_tokens, 300);
  assertEquals(stats.agents[0].cache_read_input_tokens, 0);
  assertEquals(stats.agents[0].cache_creation_input_tokens, 0);
  assertEquals(stats.agents[0].total_input_tokens, 300);
  assertEquals(stats.agents[0].output_tokens, 200);
  assertEquals(stats.agents[0].total_tokens, 500);
  assertEquals(stats.total_agent_input_tokens, 300);
  assertEquals(stats.total_agent_cache_read_input_tokens, 0);
  assertEquals(stats.total_agent_cache_creation_input_tokens, 0);
  assertEquals(stats.total_agent_total_input_tokens, 300);
  assertEquals(stats.total_agent_total_tokens, 500);

  // 5. Verify API endpoint
  const statsResponse = await routeAugment(
    testConfig(),
    requestContext("agents/usage-stats"),
  );
  const statsBody = await statsResponse.json() as AgentUsageSummary;
  assertEquals(statsBody.total_agent_total_tokens, 500);
  assertEquals(statsBody.agents[0].agent_id, agentId);
});

Deno.test("multiple agents usage stats", async () => {
  resetFakeAgentsForTest();

  // Spawn agent A
  const spawnAResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Agent A",
        agent_definition: JSON.stringify({ name: "agent-a" }),
      }),
    }),
  );
  const agentAId = String(
    ((await spawnAResponse.json() as JsonObject).tool_output as JsonObject)
      .agent_id,
  );

  // Spawn agent B
  const spawnBResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Agent B",
        agent_definition: JSON.stringify({ name: "agent-b" }),
      }),
    }),
  );
  const agentBId = String(
    ((await spawnBResponse.json() as JsonObject).tool_output as JsonObject)
      .agent_id,
  );

  reportAgentUsage(agentAId, 1000, 500);
  reportAgentUsage(agentBId, 2000, 1500);

  const stats = getAgentUsageStats();
  assertEquals(stats.agents.length, 2);
  assertEquals(stats.total_agent_input_tokens, 3000);
  assertEquals(stats.total_agent_cache_read_input_tokens, 0);
  assertEquals(stats.total_agent_cache_creation_input_tokens, 0);
  assertEquals(stats.total_agent_total_input_tokens, 3000);
  assertEquals(stats.total_agent_output_tokens, 2000);
  assertEquals(stats.total_agent_total_tokens, 5000);

  const aUsage = stats.agents.find((a) => a.agent_id === agentAId);
  const bUsage = stats.agents.find((a) => a.agent_id === agentBId);

  assertEquals(aUsage?.name, "agent-a");
  assertEquals(aUsage?.total_tokens, 1500);
  assertEquals(bUsage?.name, "agent-b");
  assertEquals(bUsage?.total_tokens, 3500);
});

Deno.test("agent usage stats track input cache split and markdown", async () => {
  resetFakeAgentsForTest();

  reportAgentUsage("agent-cache-a", 100, 40, "cache-a", 60, 20);
  reportAgentUsage("agent-cache-b", 50, 10, "cache-b", 5, 0);

  const stats = getAgentUsageStats();
  assertEquals(stats.total_agent_input_tokens, 150);
  assertEquals(stats.total_agent_cache_read_input_tokens, 65);
  assertEquals(stats.total_agent_cache_creation_input_tokens, 20);
  assertEquals(stats.total_agent_total_input_tokens, 235);
  assertEquals(stats.total_agent_output_tokens, 50);
  assertEquals(stats.total_agent_total_tokens, 285);

  const agentA = stats.agents.find((agent) =>
    agent.agent_id === "agent-cache-a"
  );
  assertEquals(agentA?.input_tokens, 100);
  assertEquals(agentA?.cache_read_input_tokens, 60);
  assertEquals(agentA?.cache_creation_input_tokens, 20);
  assertEquals(agentA?.total_input_tokens, 180);
  assertEquals(agentA?.total_tokens, 220);

  const response = await routeAugment(
    testConfig(),
    requestContext("agents/usage-stats.md"),
  );
  const markdown = await response.text();
  assertEquals(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assertEquals(markdown.includes("# Agent Token Usage"), true);
  assertEquals(markdown.includes("| Cache read input | 65 |"), true);
  assertEquals(markdown.includes("| Cache creation input | 20 |"), true);
  assertEquals(markdown.includes("| Total | 285 |"), true);
  assertEquals(markdown.includes("cache-a (agent-cache-a)"), true);
});

Deno.test("forwardAugmentJson reports agent usage", async () => {
  resetFakeAgentsForTest();

  // 1. Spawn an agent
  const spawnResponse = await routeAugment(
    testConfig(),
    requestContext("agents/run-remote-tool", {
      tool_name: "spawn-agent",
      tool_id: 26,
      tool_input_json: JSON.stringify({
        information_request: "Integration Test",
        agent_definition: JSON.stringify({ name: "integration-agent" }),
      }),
    }),
  );
  const spawnBody = await spawnResponse.json() as JsonObject;
  const agentId = String((spawnBody.tool_output as JsonObject).agent_id);

  // 2. Mock fetch for upstream
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello" } }],
          usage: { prompt_tokens: 150, completion_tokens: 50 },
        }),
        { status: 200 },
      ),
    );

  try {
    // 3. Call forwardAugmentJson with agent_id
    await forwardAugmentJson(
      testConfig(),
      requestContext("augment/chat", {
        agent_id: agentId,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    // 4. Verify usage was reported
    const stats = getAgentUsageStats();
    assertEquals(stats.agents.length, 1);
    assertEquals(stats.agents[0].agent_id, agentId);
    assertEquals(stats.agents[0].input_tokens, 150);
    assertEquals(stats.agents[0].output_tokens, 50);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

Deno.test("forwardAugmentJson reports sub-agent usage by conversation_id", async () => {
  resetFakeAgentsForTest();

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello" } }],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        { status: 200 },
      ),
    );

  try {
    await forwardAugmentJson(
      testConfig(),
      requestContext("augment/chat", {
        path: "/home/vscode/projects/augmentproxy",
        conversation_id: "child-conversation",
        parent_conversation_id: "parent-conversation",
        root_conversation_id: "parent-conversation",
        user_guidelines:
          "# Sub-Agent Prompt\n\nYou are a documentation sub-agent.",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const stats = getAgentUsageStats();
    assertEquals(stats.agents.length, 1);
    assertEquals(stats.agents[0].agent_id, "child-conversation");
    assertEquals(stats.agents[0].name, "sub-agent:docs");
    assertEquals(stats.agents[0].input_tokens, 50);
    assertEquals(stats.agents[0].cache_read_input_tokens, 20);
    assertEquals(stats.agents[0].total_input_tokens, 70);
    assertEquals(stats.agents[0].output_tokens, 30);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

Deno.test("forwardAugmentStream reports sub-agent usage by conversation_id", async () => {
  resetFakeAgentsForTest();

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        [
          `data: ${
            JSON.stringify({ choices: [{ delta: { content: "ok" } }] })
          }`,
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 80,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 30 },
              },
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

  try {
    const response = await forwardAugmentStream(
      testConfig(),
      requestContext("augment/chat-stream", {
        path: "/home/vscode/projects/augmentproxy",
        conversation_id: "stream-child-conversation",
        parent_conversation_id: "stream-parent-conversation",
        root_conversation_id: "stream-parent-conversation",
        user_guidelines:
          "# Sub-Agent Prompt\n\nYou are a documentation sub-agent.",
        message: "hi",
      }),
    );
    await response.text();

    const stats = getAgentUsageStats();
    assertEquals(stats.agents.length, 1);
    assertEquals(stats.agents[0].agent_id, "stream-child-conversation");
    assertEquals(stats.agents[0].name, "sub-agent:docs");
    assertEquals(stats.agents[0].input_tokens, 50);
    assertEquals(stats.agents[0].cache_read_input_tokens, 30);
    assertEquals(stats.agents[0].total_input_tokens, 80);
    assertEquals(stats.agents[0].output_tokens, 20);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

Deno.test("parent JSON token_usage includes accumulated sub-agent tokens", async () => {
  resetFakeAgentsForTest();

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello" } }],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 20 },
          },
        }),
        { status: 200 },
      ),
    );

  try {
    await forwardAugmentJson(
      testConfig(),
      requestContext("augment/chat", {
        conversation_id: "child-json-usage",
        parent_conversation_id: "parent-json-usage",
        root_conversation_id: "parent-json-usage",
        user_guidelines:
          "# Sub-Agent Prompt\n\nYou are a documentation sub-agent.",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const response = await forwardAugmentJson(
      testConfig(),
      requestContext("augment/chat", {
        conversation_id: "parent-json-usage",
        messages: [{ role: "user", content: "parent" }],
      }),
    );
    const body = await response.json() as JsonObject;
    const usage = body.token_usage as JsonObject;
    assertEquals(usage.sub_agent_input_tokens, 50);
    assertEquals(usage.sub_agent_cache_read_input_tokens, 20);
    assertEquals(usage.sub_agent_total_input_tokens, 70);
    assertEquals(usage.sub_agent_output_tokens, 30);
    assertEquals(usage.sub_agent_total_tokens, 100);
    assertEquals(usage.sub_agent_count, 1);
    assertEquals(usage.cache_read_input_tokens, 40);
    assertEquals(usage.input_tokens, 100);
    assertEquals(typeof usage.chat_history_tokens, "number");
    assertEquals((usage.chat_history_tokens as number) >= 70, true);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

Deno.test("parent stream token_usage includes accumulated sub-agent tokens", async () => {
  resetFakeAgentsForTest();

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(
        [
          `data: ${
            JSON.stringify({ choices: [{ delta: { content: "ok" } }] })
          }`,
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 80,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 30 },
              },
            })
          }`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

  try {
    let response = await forwardAugmentStream(
      testConfig(),
      requestContext("augment/chat-stream", {
        conversation_id: "child-stream-usage",
        parent_conversation_id: "parent-stream-usage",
        root_conversation_id: "parent-stream-usage",
        user_guidelines:
          "# Sub-Agent Prompt\n\nYou are a documentation sub-agent.",
        message: "hi",
      }),
    );
    await response.text();

    response = await forwardAugmentStream(
      testConfig(),
      requestContext("augment/chat-stream", {
        conversation_id: "parent-stream-usage",
        message: "parent",
      }),
    );
    const chunks = (await response.text()).split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as JsonObject);
    const done = chunks.find((chunk) => chunk.done === true) as JsonObject;
    const usage = done.token_usage as JsonObject;
    assertEquals(usage.sub_agent_input_tokens, 50);
    assertEquals(usage.sub_agent_cache_read_input_tokens, 30);
    assertEquals(usage.sub_agent_total_input_tokens, 80);
    assertEquals(usage.sub_agent_output_tokens, 20);
    assertEquals(usage.sub_agent_total_tokens, 100);
    assertEquals(usage.sub_agent_count, 1);
    assertEquals(usage.cache_read_input_tokens, 60);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});
