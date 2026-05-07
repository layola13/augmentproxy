import { routeAugment } from "./augment-router.ts";
import { resetFakeAgentsForTest } from "./fake-augment.ts";
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

Deno.test({
  name: "reset fake agents state",
  fn() {
    resetFakeAgentsForTest();
  },
  sanitizeOps: false,
  sanitizeResources: false,
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
