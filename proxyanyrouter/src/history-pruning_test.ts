import {
  DEFAULT_HISTORY_PRUNE_OPTIONS,
  pruneRequestHistory,
} from "./history-pruning.ts";
import type { JsonObject } from "./types.ts";

function message(role: string, text: string): JsonObject {
  return {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  };
}

Deno.test("pruneRequestHistory drops old reasoning and shrinks old tool outputs", () => {
  const largeOutput = "A".repeat(4000);
  const recentOutput = "B".repeat(1200);
  const request: JsonObject = {
    input: [
      message("user", "u1"),
      { type: "reasoning", summary: [{ type: "summary_text", text: "old reasoning" }] },
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: `{"cmd":"${"x".repeat(800)}"}` },
      { type: "function_call_output", call_id: "c1", output: largeOutput },
      message("assistant", "a1"),
      message("user", "u2"),
      { type: "function_call_output", call_id: "c2", output: recentOutput },
      message("assistant", "a2"),
      message("user", "u3"),
    ],
  };

  const { request: pruned, summary } = pruneRequestHistory(request, {
    ...DEFAULT_HISTORY_PRUNE_OPTIONS,
    keepRecentUserMessages: 2,
    keepRecentItems: 4,
    oldToolOutputPreviewChars: 120,
    oldFunctionArgumentsPreviewChars: 60,
  });

  const input = Array.isArray(pruned.input) ? pruned.input : [];
  if (input.length !== 8) {
    throw new Error(`expected 8 items after pruning, got ${input.length}`);
  }
  if (summary.droppedReasoningCount !== 1) {
    throw new Error(`expected one dropped reasoning item, got ${summary.droppedReasoningCount}`);
  }
  if (summary.truncatedToolOutputCount !== 1) {
    throw new Error(
      `expected one truncated tool output, got ${summary.truncatedToolOutputCount}`,
    );
  }
  if (summary.truncatedFunctionCallCount !== 1) {
    throw new Error(
      `expected one truncated function call, got ${summary.truncatedFunctionCallCount}`,
    );
  }

  const oldOutput = input[2] as JsonObject;
  if (typeof oldOutput.output !== "string" || !String(oldOutput.output).includes("pruned old tool output")) {
    throw new Error("old tool output was not summarized");
  }

  const recentToolOutput = input[5] as JsonObject;
  if (recentToolOutput.output !== recentOutput) {
    throw new Error("recent tool output should remain unchanged");
  }

  const finalUser = input[input.length - 1] as JsonObject;
  if (finalUser.role !== "user") {
    throw new Error("final user message should remain intact");
  }
});
