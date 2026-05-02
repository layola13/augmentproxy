import type { JsonObject, JsonValue } from "./src/types.ts";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const port = envNumber("PROXYANYROUTER_MOCK_PORT", 8877);
const logPath = env("PROXYANYROUTER_MOCK_LOG", "/tmp/proxyanyrouter-mock.log");

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function appendLog(entry: JsonObject): Promise<void> {
  await Deno.writeTextFile(logPath, `${JSON.stringify(entry)}\n`, { append: true });
}

function sse(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function findToolByName(body: JsonObject, name: string): JsonObject | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.find((tool) => stringValue(objectValue(tool).name) === name) as JsonObject | undefined;
}

console.log(`proxyanyrouter mock upstream listening on http://127.0.0.1:${port}`);
console.log(`proxyanyrouter mock log: ${logPath}`);

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    return new Response("not found", { status: 404 });
  }

  const rawBody = await request.text();
  const body = objectValue(JSON.parse(rawBody) as JsonValue);
  await appendLog({
    path: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    body,
  });

  const flattenedToolName = "mcp__proxyanyrouter_local__read_anyrouter_doc";
  const previousResponseId = stringValue(body.previous_response_id);
  if (!previousResponseId) {
    const tool = findToolByName(body, flattenedToolName);
    if (!tool) {
      return new Response(
        JSON.stringify({ error: `missing flattened tool ${flattenedToolName}` }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (Array.isArray(body.tools) && body.tools.some((item) => objectValue(item).type === "namespace")) {
      return new Response(
        JSON.stringify({ error: "namespace tools should have been flattened before upstream" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return textResponse([
      sse("response.created", { response: { id: "resp-1" } }),
      sse("response.output_item.done", {
        item: {
          type: "function_call",
          call_id: "call-1",
          name: flattenedToolName,
          arguments: "{}",
        },
      }),
      sse("response.completed", {
        response: {
          id: "resp-1",
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      }),
    ].join(""));
  }

  if (previousResponseId !== "resp-1") {
    return new Response(
      JSON.stringify({ error: `unexpected previous_response_id ${previousResponseId}` }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const input = Array.isArray(body.input) ? body.input : [];
  const outputItem = input.find((item) => objectValue(item).type === "function_call_output");
  const outputRecord = objectValue(outputItem);
  if (stringValue(outputRecord.call_id) !== "call-1") {
    return new Response(
      JSON.stringify({ error: "missing function_call_output for call-1" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const outputText = stringValue(outputRecord.output);
  if (!outputText || !outputText.includes("wire_api = \"responses\"")) {
    return new Response(
      JSON.stringify({ error: "function_call_output missing anyrouter.md content" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  return textResponse([
    sse("response.created", { response: { id: "resp-2" } }),
    sse("response.output_text.delta", { delta: "wire_api = " }),
    sse("response.output_text.delta", { delta: "responses" }),
    sse("response.output_item.done", {
      item: {
        type: "message",
        role: "assistant",
        id: "msg-1",
        content: [{ type: "output_text", text: "wire_api = responses" }],
      },
    }),
    sse("response.completed", {
      response: {
        id: "resp-2",
        usage: { input_tokens: 60, output_tokens: 8, total_tokens: 68 },
      },
    }),
  ].join(""));
});
