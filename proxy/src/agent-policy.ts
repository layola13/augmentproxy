import type { JsonObject, RequestContext, ToolPolicy } from "./types.ts";
import { AgentExecutionMode, RequestIntent } from "./types.ts";

function objectBody(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body as JsonObject
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function currentNodeUserText(nodes: unknown): string {
  for (const node of asArray(nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const record = node as JsonObject;
    const textNode = record.text_node;
    if (textNode && typeof textNode === "object" && !Array.isArray(textNode)) {
      const content = text((textNode as JsonObject).content).trim();
      if (content) return content;
    }
    const content = text(record.content).trim();
    if (content) return content;
  }
  return "";
}

function hasToolResultNodes(nodes: unknown): boolean {
  return asArray(nodes).some((node) =>
    Boolean(node) && typeof node === "object" && !Array.isArray(node) &&
    Boolean((node as JsonObject).tool_result_node)
  );
}

function hasRecentHistoryToolResultNodes(history: unknown, maxTurns = 3): boolean {
  const items = asArray(history).slice(-maxTurns);
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    if (
      hasToolResultNodes(record.request_nodes) ||
      hasToolResultNodes(record.response_nodes)
    ) {
      return true;
    }
  }
  return false;
}

function hasToolDefinitions(ctx: RequestContext): boolean {
  const body = objectBody(ctx);
  return asArray(body.tool_definitions).some((item) =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
    typeof (item as JsonObject).name === "string" &&
    String((item as JsonObject).name).trim().length > 0
  );
}

function isContinuationText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "继续" || normalized === "continue" ||
    normalized === "go on" || normalized === "next" ||
    normalized.includes("继续");
}

function isAuxiliaryTitleRequestText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const titleSignals = [
    "provide a clear and concise title",
    "title for this message",
    "title must be less than",
  ];
  return titleSignals.some((signal) => lower.includes(signal)) &&
    lower.includes("message:");
}

function isAuxiliaryContinuationSummaryRequestText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return lower.includes("create a compact continuation summary") &&
    lower.includes("continue the same task after context compaction");
}

export function detectAgentExecutionMode(ctx: RequestContext): AgentExecutionMode {
  const body = objectBody(ctx);
  const values = [
    body.agent_name,
    body.name,
    body.mode,
    body.user_guidelines,
    body.workspace_guidelines,
    body.system_prompt,
    body.system_prompt_append,
  ];
  const sessionConfig = body.session_config;
  if (sessionConfig && typeof sessionConfig === "object" && !Array.isArray(sessionConfig)) {
    const config = sessionConfig as JsonObject;
    values.push(config.mode, config.agent_name, config.name);
    const definition = config.agent_definition;
    if (definition && typeof definition === "object" && !Array.isArray(definition)) {
      values.push((definition as JsonObject).name, (definition as JsonObject).description);
    }
  }
  const haystack = values.map((value) => text(value).toLowerCase()).join("\n");
  if (haystack.includes("askexpert") || haystack.includes("ask expert")) {
    return AgentExecutionMode.AskExpert;
  }
  if (haystack.includes("planning sub-agent") || haystack.includes("planning agent")) {
    return AgentExecutionMode.Plan;
  }
  if (haystack.includes("read-only investigation sub-agent") || haystack.includes("sub-agent-explore")) {
    return AgentExecutionMode.Explore;
  }
  if (haystack.includes("sub-agent-code") || haystack.includes("writable implementation sub-agent")) {
    return AgentExecutionMode.Code;
  }
  if (haystack.includes("sub-agent-validate") || haystack.includes("validation sub-agent")) {
    return AgentExecutionMode.Validate;
  }
  return AgentExecutionMode.Main;
}

export function detectRequestIntent(ctx: RequestContext): RequestIntent {
  const body = objectBody(ctx);
  const currentText = currentNodeUserText(body.nodes) || text(body.message) ||
    text(body.prompt) || text(body.instruction);
  const lower = currentText.trim().toLowerCase();
  if (isAuxiliaryTitleRequestText(currentText)) return RequestIntent.TitleOnly;
  if (isAuxiliaryContinuationSummaryRequestText(currentText)) {
    return RequestIntent.CompactSummary;
  }
  if (isContinuationText(currentText)) return RequestIntent.Continue;
  if (
    /\b(plan|planning|开发计划|方案|评估后计划)\b/i.test(currentText)
  ) return RequestIntent.Plan;
  if (
    /\b(test|tests|compile|build|validate|verify|运行|编译|测试|验收)\b/i.test(currentText)
  ) return RequestIntent.Validate;
  if (
    /\b(implement|fix|edit|refactor|write|modify|create|coding|修复|重构|修改|实现)\b/i.test(currentText)
  ) return RequestIntent.Implement;
  if (
    /\b(explore|inspect|analyze|evaluate|调查|探索|评估|查看)\b/i.test(currentText)
  ) return RequestIntent.Evaluate;
  if (!lower) return RequestIntent.Continue;
  return RequestIntent.Unknown;
}

export function buildToolPolicy(
  ctx: RequestContext,
  allowedToolNames?: Set<string>,
): ToolPolicy {
  const body = objectBody(ctx);
  const mode = detectAgentExecutionMode(ctx);
  const intent = detectRequestIntent(ctx);
  const readOnly = mode === AgentExecutionMode.Explore;
  const currentText = currentNodeUserText(body.nodes) || text(body.message) ||
    text(body.prompt) || text(body.instruction);
  const continuationSuppressed = intent === RequestIntent.TitleOnly ||
    intent === RequestIntent.CompactSummary;
  const retryStalledContinuation = !continuationSuppressed &&
    (hasToolResultNodes(body.nodes) || isContinuationText(currentText) ||
      (!currentText.trim() && hasRecentHistoryToolResultNodes(body.chat_history)));
  const preferToolContinuation = hasToolDefinitions(ctx) &&
    !continuationSuppressed &&
    (
      hasToolResultNodes(body.nodes) ||
      isContinuationText(currentText) ||
      (!currentText.trim() && hasRecentHistoryToolResultNodes(body.chat_history)) ||
      text(body.mode).toUpperCase().includes("AGENT")
    );
  return {
    mode,
    intent,
    readOnly,
    preferToolContinuation,
    retryStalledContinuation,
    allowAgentSwitching:
      mode === AgentExecutionMode.Main || mode === AgentExecutionMode.Plan,
    allowedToolNames,
  };
}

function containsAnySignal(textValue: string, signals: string[]): boolean {
  return signals.some((signal) => textValue.includes(signal));
}

export function isBroadWorkspaceExplorationInstruction(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  const scopeSignals = [
    "project",
    "workspace",
    "repository",
    "repo",
    "directory",
    "codebase",
  ];
  const broadSignals = [
    "explore the",
    "inspect the",
    "analyze the",
    "survey the",
    "start by exploring",
    "thoroughly",
    "overall project structure",
    "file organization",
    "current state",
    "need to understand",
    "understand:",
    "comprehensive",
  ];
  if (
    containsAnySignal(lower, scopeSignals) &&
    containsAnySignal(lower, broadSignals)
  ) {
    return true;
  }
  const numberedSections = (instruction.match(/\b[1-9]\./g) ?? []).length;
  return instruction.length >= 220 && numberedSections >= 2 &&
    containsAnySignal(lower, scopeSignals);
}

export function preferredSubAgentForInstruction(
  toolName: string,
  instruction: string,
  allowedTools?: Set<string>,
): string | undefined {
  if (!allowedTools) return undefined;
  const trimmed = instruction.trim();
  if (!trimmed) return undefined;
  const writeRegex =
    /^(?:please\s+)?(?:save|write|create|edit|modify|update|rewrite|patch|implement|refactor|mkdir)\b/i;
  const validateRegex =
    /^(?:please\s+)?(?:run|test|compile|build|validate|verify|reproduce|execute|haxe|deno|npm|pnpm|cargo)\b/i;

  if (
    (toolName === "sub-agent-explore" || toolName === "sub-agent-plan") &&
    writeRegex.test(trimmed) &&
    allowedTools.has("sub-agent-code")
  ) {
    return "sub-agent-code";
  }
  if (
    (toolName === "sub-agent-explore" || toolName === "sub-agent-plan") &&
    validateRegex.test(trimmed) &&
    allowedTools.has("sub-agent-validate")
  ) {
    return "sub-agent-validate";
  }
  if (
    (toolName === "sub-agent-code" || toolName === "sub-agent-validate") &&
    isBroadWorkspaceExplorationInstruction(trimmed)
  ) {
    if (allowedTools.has("sub-agent-plan")) return "sub-agent-plan";
    if (allowedTools.has("sub-agent-explore")) return "sub-agent-explore";
  }
  return undefined;
}
