import { forwardAugmentStream } from "../src/openai-adapter.ts";
import type { JsonObject, ProxyConfig, RequestContext } from "../src/types.ts";

function replayConfig(): ProxyConfig {
  const defaultChannel = {
    baseUrl: "https://example.test/v1",
    apiKeys: ["test-openai-key"],
    model: "test-model",
  };
  return {
    port: 0,
    switchApi: "OPENAI",
    activeChannel: "default",
    expertChannel: "",
    channels: { default: defaultChannel },
    modelMapping: {},
    openaiBaseUrl: defaultChannel.baseUrl,
    codexBaseUrl: "https://codex.example.test/v1",
    openaiApiKeys: [...defaultChannel.apiKeys],
    codexApiKey: "test-codex-key",
    openaiModel: "test-model",
    codexModel: "test-codex-model",
    openaiUserAgent: "replay-loop-script",
    upstreamAppName: "ReplayLoopScript",
    sanitizeUpstreamPrompts: false,
    augmentModelContextTokens: 128000,
    augmentModelMaxOutputTokens: 4096,
    augmentHistoryTailTokens: 16000,
    augmentHistoryMaxChars: 64000,
    augmentHistorySummaryPrompt: "",
    fakeAugmentEmail: "replay@example.test",
    fakeAugmentUserId: "replay-user",
    requestLogDir: "",
    indexingMode: "off",
    embedBaseUrl: "https://embed.example.test/v1",
    embedApiKeys: ["test-embed-key"],
    embedModel: "test-embed-model",
    embedDimensions: 1536,
    qdrantUrl: "http://127.0.0.1:6333",
    qdrantCollection: "replay",
    indexChunkChars: 1800,
    indexChunkOverlap: 200,
    logLevel: "error",
  };
}

function classifyToolCall(toolName: string, input: JsonObject): string {
  if (toolName === "view") return `view:${String(input.path ?? "")}`;
  if (toolName === "launch-process") {
    const command = String(input.command ?? "");
    if (command.includes("grep -RIn")) return "launch:grep";
    if (command.includes("repeated failed tool call was suppressed")) {
      return "launch:exhausted";
    }
    if (command.includes("printf")) return "launch:directive";
    if (command.includes("haxe -p src")) return "launch:compile";
    return `launch:${command.slice(0, 80)}`;
  }
  return toolName;
}

function toolResultFor(
  toolName: string,
  input: JsonObject,
  nextStatePath: string,
  statePath: string,
  compileFailure: string,
): { content: string; isError: boolean } {
  if (toolName === "view" && String(input.path ?? "") === nextStatePath) {
    return {
      content:
        `Here's the result of running \`cat -n\` on ${nextStatePath}:\n     1\tclass NextState<T:States> {}\n`,
      isError: false,
    };
  }
  if (toolName === "view" && String(input.path ?? "") === statePath) {
    return {
      content:
        `Here's the result of running \`cat -n\` on ${statePath}:\n     1\tinterface States {}\n`,
      isError: false,
    };
  }
  if (toolName === "view") {
    return {
      content: `Directory listing result for ${String(input.path ?? "")}\n`,
      isError: false,
    };
  }

  const command = String(input.command ?? "");
  if (command.includes("grep -RIn")) {
    return {
      content: [
        "Here are the results from executing the command.",
        "<return-code>",
        "0",
        "</return-code>",
        "<output>",
        "./src/haxe/state/State.hx:1:interface States {}",
        "./src/haxe/state/NextState.hx:1:class NextState<T:States> {}",
        "",
        "</output>",
      ].join("\n"),
      isError: false,
    };
  }
  if (command.includes("printf")) {
    return {
      content: [
        "Here are the results from executing the command.",
        "<return-code>",
        "0",
        "</return-code>",
        "<output>",
        "augmentproxy directive printed",
        "",
        "</output>",
      ].join("\n"),
      isError: false,
    };
  }

  return { content: compileFailure, isError: true };
}

const rounds = Number(Deno.args[0] ?? 120);
const root = await Deno.makeTempDir({
  dir: "/home/vscode/projects/augmentproxy/proxy",
  prefix: "loop-replay-",
});
const stateDir = `${root}/src/haxe/state`;
const nextStatePath = `${stateDir}/NextState.hx`;
const statePath = `${stateDir}/State.hx`;
await Deno.mkdir(stateDir, { recursive: true });
await Deno.writeTextFile(
  nextStatePath,
  "package haxe.state;\nclass NextState<T:States> {}\n",
);
await Deno.writeTextFile(
  statePath,
  "package haxe.state;\ninterface States {}\nclass State<T:States> {}\n",
);

const command =
  "cd /home/vscode/projects/bevy_haxe && haxe -p src -main TestAll --interp 2>&1";
const compileFailure = [
  "Here are the results from executing the command.",
  "<return-code>",
  "1",
  "</return-code>",
  "<output>",
  "src/haxe/state/NextState.hx:21: characters 19-25 : Type not found : States",
  "",
  "</output>",
].join("\n");

const bodyBase: JsonObject = {
  path: root,
  tool_definitions: [
    {
      name: "view",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, type: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "launch-process",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          wait: { type: "boolean" },
          max_wait_seconds: { type: "number" },
        },
        required: ["command"],
      },
    },
    {
      name: "str-replace-editor",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          command: { type: "string" },
          str_replace_entries: { type: "array" },
        },
        required: ["path"],
      },
    },
  ],
};

const chatHistory: JsonObject[] = [];
let nodes: JsonObject[] = [{
  id: 1,
  type: 4,
  ide_state_node: {
    workspace_folders: [{ repository_root: root, folder_root: root }],
    current_terminal: {
      terminal_id: 0,
      current_working_directory: root,
    },
  },
}];

const originalFetch = globalThis.fetch;
const counts = new Map<string, number>();
let repeatedBad = 0;

async function runRound(round: number): Promise<string[]> {
  const upstreamCall = {
    id: `call_model_compile_${round}`,
    index: 0,
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
  };

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        [
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [upstreamCall] } }],
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )) as typeof fetch;

  const body = { ...bodyBase, chat_history: chatHistory, nodes } as JsonObject;
  const ctx: RequestContext = {
    requestId: `loop-${round}`,
    method: "POST",
    url: new URL("http://localhost/chat-stream"),
    path: "/chat-stream",
    headers: new Headers(),
    body,
    rawBody: JSON.stringify(body),
  };

  const streamText = await (await forwardAugmentStream(replayConfig(), ctx))
    .text();
  const objects = streamText
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as JsonObject);
  const responseNodes = objects
    .flatMap((item) => Array.isArray(item.nodes) ? item.nodes as JsonObject[] : [])
    .filter((node) => Boolean((node as JsonObject).tool_use));

  const requestNodes: JsonObject[] = [{
    id: 1,
    type: 4,
    ide_state_node: {
      workspace_folders: [{ repository_root: root, folder_root: root }],
      current_terminal: {
        terminal_id: 0,
        current_working_directory: root,
      },
    },
  }];

  const labels: string[] = [];
  for (const node of responseNodes) {
    const toolUse = (node as JsonObject).tool_use as JsonObject;
    const toolName = String(toolUse.tool_name ?? "");
    const input = JSON.parse(String(toolUse.input_json ?? "{}")) as JsonObject;
    const label = classifyToolCall(toolName, input);
    labels.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const result = toolResultFor(
      toolName,
      input,
      nextStatePath,
      statePath,
      compileFailure,
    );
    requestNodes.push({
      id: requestNodes.length + 1,
      type: 1,
      tool_result_node: {
        tool_use_id: String(toolUse.tool_use_id ?? ""),
        content: result.content,
        is_error: result.isError,
      },
    });
  }

  chatHistory.push({ request_nodes: nodes, response_nodes: responseNodes });
  nodes = requestNodes;

  if (labels.includes(`view:${statePath}`) && (counts.get(`view:${statePath}`) ?? 0) > 1) {
    repeatedBad += 1;
  }
  if (labels.includes("launch:grep") && (counts.get("launch:grep") ?? 0) > 1) {
    repeatedBad += 1;
  }
  if ((counts.get("launch:directive") ?? 0) > 1) repeatedBad += 1;

  return labels;
}

try {
  for (let i = 0; i < rounds; i += 1) {
    const labels = await runRound(i);
    if (i < 12 || i % 20 === 0) {
      console.log("round", i, labels.join(","));
    }
    if (repeatedBad !== 0) {
      throw new Error(`repeated bad auto-recovery count ${repeatedBad}`);
    }
  }
  console.log("counts", JSON.stringify(Object.fromEntries(counts), null, 2));
  console.log("repeatedBad", repeatedBad);
} finally {
  globalThis.fetch = originalFetch;
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
}
