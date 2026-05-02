import { loadConfig } from "./config.ts";
import {
  executeBridgeCall,
  extractBridgeCall,
  flattenBridgeToolsInRequest,
  isAnyFunctionCall,
  loadBridgeRegistry,
} from "./mcp-bridge.ts";
import type { JsonObject, JsonValue, ProxyAnyRouterConfig } from "./types.ts";

const config = loadConfig();

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonRequestBody(raw: string): JsonObject {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as JsonValue;
  return objectValue(parsed);
}

type ParsedSseEvent = {
  type: string;
  data: JsonObject;
};

type UpstreamTurn = {
  events: ParsedSseEvent[];
  responseId?: string;
  usage?: JsonObject;
};

function encodeSseEvent(event: ParsedSseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

async function parseSseResponse(response: Response): Promise<UpstreamTurn> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Upstream response body is empty.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const events: ParsedSseEvent[] = [];
  let responseId: string | undefined;
  let usage: JsonObject | undefined;

  const flushBlock = (block: string) => {
    const trimmed = block.trim();
    if (!trimmed) return;
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!eventType || dataLines.length === 0) return;
    const data = JSON.parse(dataLines.join("\n")) as JsonObject;
    events.push({ type: eventType, data });
    const createdId = stringValue(objectValue(data.response).id);
    if (createdId) responseId = createdId;
    const responseUsage = objectValue(objectValue(data.response).usage);
    if (Object.keys(responseUsage).length > 0) usage = responseUsage;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const block of parts) flushBlock(block);
  }
  if (buffer.trim()) flushBlock(buffer);
  return { events, responseId, usage };
}

function forwardHeaders(incoming: Headers, config: ProxyAnyRouterConfig): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const normalized = key.toLowerCase();
    if (normalized === "host" || normalized === "content-length") continue;
    if (normalized === "authorization") continue;
    headers.set(key, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  if (config.upstreamApiKey) {
    headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  } else if (incoming.get("authorization")) {
    headers.set("authorization", incoming.get("authorization")!);
  }
  return headers;
}

async function fetchUpstreamTurn(
  currentRequest: JsonObject,
  incomingHeaders: Headers,
): Promise<UpstreamTurn> {
  const upstream = await fetch(config.upstreamUrl, {
    method: "POST",
    headers: forwardHeaders(incomingHeaders, config),
    body: JSON.stringify(currentRequest),
  });
  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    throw new Error(
      `Upstream returned ${upstream.status}: ${raw.slice(0, 800) || "<empty body>"}`,
    );
  }
  return await parseSseResponse(upstream);
}

function buildFollowUpRequest(
  previousRequest: JsonObject,
  responseId: string,
  outputs: JsonValue[],
): JsonObject {
  const next: JsonObject = { ...previousRequest };
  next.previous_response_id = responseId;
  next.input = outputs;
  return next;
}

async function runBridgeLoop(
  originalRequest: JsonObject,
  incomingHeaders: Headers,
): Promise<UpstreamTurn> {
  const registry = await loadBridgeRegistry(config.mcpConfigPath);
  let currentRequest = flattenBridgeToolsInRequest(
    structuredClone(originalRequest),
    registry,
  );

  for (let step = 0; step < config.maxBridgeSteps; step += 1) {
    const turn = await fetchUpstreamTurn(currentRequest, incomingHeaders);
    const bridgeCalls = turn.events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => extractBridgeCall(event.data.item, registry))
      .filter((
        value,
      ): value is { callId: string; qualifiedName: string; argumentsJson: string } =>
        Boolean(value)
      );

    if (bridgeCalls.length === 0) return turn;

    const nonBridgeFunctionCalls = turn.events.some((event) => {
      if (event.type !== "response.output_item.done") return false;
      const item = objectValue(event.data.item);
      return isAnyFunctionCall(item) && !extractBridgeCall(item, registry);
    });
    if (nonBridgeFunctionCalls) return turn;

    if (!turn.responseId) {
      throw new Error("Upstream emitted bridge tool calls without response.created id.");
    }

    const outputs: JsonValue[] = [];
    for (const call of bridgeCalls) {
      const output = await executeBridgeCall(call, registry);
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output,
      });
    }
    currentRequest = buildFollowUpRequest(currentRequest, turn.responseId, outputs);
  }

  throw new Error(`Exceeded max bridge steps (${config.maxBridgeSteps}).`);
}

function buildJsonResponse(turn: UpstreamTurn): JsonObject {
  const output: JsonValue[] = [];
  let outputText = "";
  for (const event of turn.events) {
    if (event.type === "response.output_item.done") {
      const item = objectValue(event.data.item);
      output.push(item);
      if (stringValue(item.type) === "message") {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          const record = objectValue(part);
          if (stringValue(record.type) === "output_text") {
            outputText += stringValue(record.text) ?? "";
          }
        }
      }
    }
    if (event.type === "response.output_text.delta") {
      outputText += stringValue(event.data.delta) ?? "";
    }
  }
  return {
    id: turn.responseId ?? "",
    object: "response",
    output,
    output_text: outputText,
    usage: turn.usage ?? {},
  };
}

async function handleResponsesRequest(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const body = parseJsonRequestBody(rawBody);
  const wantsJson = body.stream === false ||
    request.headers.get("accept")?.includes("application/json");

  if (wantsJson) {
    const finalTurn = await runBridgeLoop(body, request.headers);
    return jsonResponse(buildJsonResponse(finalTurn));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(encodeSseComment("heartbeat")));
      }, config.heartbeatMs);

      void (async () => {
        try {
          controller.enqueue(encoder.encode(encodeSseComment("connected")));
          const finalTurn = await runBridgeLoop(body, request.headers);
          for (const event of finalTurn.events) {
            controller.enqueue(encoder.encode(encodeSseEvent(event)));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const event: ParsedSseEvent = {
            type: "error",
            data: {
              type: "error",
              error: {
                code: "proxyanyrouter_error",
                message,
              },
            },
          };
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
        } finally {
          clearInterval(heartbeat);
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

console.log(`proxyanyrouter listening on http://127.0.0.1:${config.port}`);
console.log(`proxyanyrouter upstream: ${config.upstreamUrl}`);
console.log(`proxyanyrouter mcp config: ${config.mcpConfigPath}`);

Deno.serve({ port: config.port }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "proxyanyrouter" });
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    try {
      return await handleResponsesRequest(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({
        error: {
          code: "proxyanyrouter_error",
          message,
        },
      }, 500);
    }
  }
  return jsonResponse({
    error: {
      code: "not_found",
      message: `Unsupported path: ${url.pathname}`,
    },
  }, 404);
});
