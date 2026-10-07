// Zero-spend unit tests for server/mapping.ts pure helpers.
// Run: node --test server/mapping.test.ts
// No SDK imports, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CursorSDKMessage, CursorTokenUsage } from "./cursor-sdk-types.ts";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { describeTaskArgs, describeTaskResult, publishableConfig, taskArgsOf, toProviderError, toProviderModels, toTimelineItem, toUsage } from "./mapping.ts";

const IDS = { itemId: "item:1" };

function usage(overrides: Partial<CursorTokenUsage> = {}): CursorTokenUsage {
  return {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    ...overrides,
  };
}

describe("taskArgsOf", () => {
  it("extracts description, prompt, and subagentType", () => {
    assert.deepEqual(taskArgsOf({ description: "do thing", prompt: "do the thing", subagentType: "explore" }), {
      description: "do thing",
      prompt: "do the thing",
      subagentType: "explore",
    });
  });

  it("falls back to snake_case subagent_type", () => {
    assert.equal(taskArgsOf({ subagent_type: "plan" }).subagentType, "plan");
  });

  it("prefers camelCase subagentType over snake_case", () => {
    assert.equal(taskArgsOf({ subagentType: "a", subagent_type: "b" }).subagentType, "a");
  });

  it("drops non-string fields", () => {
    const out = taskArgsOf({ description: 42, prompt: ["x"], subagentType: null });
    assert.equal(out.description, undefined);
    assert.equal(out.prompt, undefined);
    assert.equal(out.subagentType, undefined);
  });

  it("returns empty fields for non-record inputs", () => {
    for (const input of [null, undefined, 42, "prompt", ["description"], true]) {
      const out = taskArgsOf(input);
      assert.equal(out.description, undefined, String(input));
      assert.equal(out.prompt, undefined, String(input));
      assert.equal(out.subagentType, undefined, String(input));
    }
  });
});

describe("describeTaskArgs", () => {
  it("returns the description when there is no prompt", () => {
    assert.equal(describeTaskArgs({ description: "explore auth" }), "explore auth");
  });

  it("falls back to 'subagent' with no description", () => {
    assert.equal(describeTaskArgs({}), "subagent");
    assert.equal(describeTaskArgs(null), "subagent");
  });

  it("joins description and prompt", () => {
    assert.equal(describeTaskArgs({ description: "explore", prompt: "map the auth flow" }), "explore: map the auth flow");
  });

  it("does not duplicate the prompt when it equals the head", () => {
    assert.equal(describeTaskArgs({ description: "same", prompt: "same" }), "same");
  });

  it("truncates long prompts at 240 chars with an ellipsis", () => {
    const prompt = "p".repeat(300);
    const out = describeTaskArgs({ description: "d", prompt });
    assert.equal(out, `d: ${"p".repeat(240)}…`);
    assert.equal(out?.length, "d: ".length + 241);
  });
});

describe("describeTaskResult", () => {
  it("uses the last non-empty conversation step text", () => {
    const result = {
      value: {
        conversationSteps: [
          { assistantMessage: { text: "first" } },
          { assistantMessage: { text: "" } },
          { assistantMessage: { text: "last" } },
        ],
      },
    };
    assert.equal(describeTaskResult(result, false), "Subagent result: last");
    assert.equal(describeTaskResult(result, true), "Subagent failed: last");
  });

  it("ignores top-level text when an object value is present", () => {
    const result = { value: { conversationSteps: [{ nope: 1 }, { assistantMessage: {} }] }, text: "nested" };
    assert.equal(describeTaskResult(result, false), "Subagent finished");
    assert.equal(describeTaskResult({ text: "nested" }, false), "Subagent result: nested");
  });

  it("prefers status.value over value and text", () => {
    assert.equal(describeTaskResult({ status: { value: "s" }, value: "v", text: "t" }, false), "Subagent result: s");
    assert.equal(describeTaskResult({ value: "v", text: "t" }, false), "Subagent result: v");
    assert.equal(describeTaskResult({ text: "t" }, false), "Subagent result: t");
  });

  it("handles flat string results", () => {
    assert.equal(describeTaskResult("done", false), "Subagent result: done");
    assert.equal(describeTaskResult("broke", true), "Subagent failed: broke");
  });

  it("falls back to a bare finished/failed label", () => {
    assert.equal(describeTaskResult({}, false), "Subagent finished");
    assert.equal(describeTaskResult({}, true), "Subagent failed");
    assert.equal(describeTaskResult(null, false), "Subagent finished");
  });

  it("truncates long result text at 500 chars with an ellipsis", () => {
    const long = "x".repeat(600);
    assert.equal(describeTaskResult(long, false), `Subagent result: ${"x".repeat(500)}…`);
    assert.equal(
      describeTaskResult({ text: long }, true),
      `Subagent failed: ${"x".repeat(500)}…`,
    );
    const steps = { value: { conversationSteps: [{ assistantMessage: { text: long } }] } };
    assert.equal(describeTaskResult(steps, false), `Subagent result: ${"x".repeat(500)}…`);
  });
});

describe("toTimelineItem", () => {
  it("maps assistant text blocks", () => {
    const event: CursorSDKMessage = {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: { role: "assistant", content: [{ type: "text", text: "he" }, { type: "text", text: "llo" }] },
    };
    assert.deepEqual(toTimelineItem(event, IDS), {
      type: "assistant_message",
      id: "item:1",
      messageId: "item:1",
      text: "hello",
    });
  });

  it("drops assistant messages with no text", () => {
    const event: CursorSDKMessage = {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: { role: "assistant", content: [] },
    };
    assert.equal(toTimelineItem(event, IDS), null);
  });

  it("maps thinking to reasoning and drops empty thinking", () => {
    const event: CursorSDKMessage = { type: "thinking", agent_id: "a", run_id: "r", text: "hmm" };
    assert.deepEqual(toTimelineItem(event, IDS), { type: "reasoning", id: "item:1", text: "hmm" });
    assert.equal(toTimelineItem({ type: "thinking", agent_id: "a", run_id: "r", text: "" }, IDS), null);
  });

  it("maps a running tool call with the call id", () => {
    const event: CursorSDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "call:9",
      name: "shell",
      status: "running",
      args: { command: "ls" },
    };
    const item = toTimelineItem(event, IDS);
    assert.equal(item?.type, "tool_call");
    assert.equal((item as { callId: string }).callId, "call:9");
    assert.equal((item as { status: string }).status, "running");
    assert.equal((item as { error: unknown }).error, null);
    assert.deepEqual((item as { detail: unknown }).detail, { type: "shell", command: "ls", output: undefined });
  });

  it("falls back to the item id when call_id is empty", () => {
    const event: CursorSDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "",
      name: "read",
      status: "running",
      args: { path: "a.ts" },
    };
    assert.equal((toTimelineItem(event, IDS) as { callId: string }).callId, "item:1");
  });

  it("maps a completed tool call", () => {
    const event: CursorSDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c",
      name: "read",
      status: "completed",
      args: { path: "a.ts" },
      result: "contents",
    };
    const item = toTimelineItem(event, IDS);
    assert.equal((item as { status: string }).status, "completed");
    assert.equal((item as { error: unknown }).error, null);
    assert.deepEqual((item as { detail: unknown }).detail, {
      type: "read",
      filePath: "a.ts",
      content: "contents",
    });
  });

  it("maps a failed tool call with an error payload", () => {
    const event: CursorSDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c",
      name: "shell",
      status: "error",
      args: { command: "exit 1" },
      result: "boom",
    };
    const item = toTimelineItem(event, IDS);
    assert.equal((item as { status: string }).status, "failed");
    assert.notEqual((item as { error: unknown }).error, null);
  });

  it("maps tool detail shapes per tool name", () => {
    const cases: Array<{ name: string; args: unknown; detail: unknown }> = [
      { name: "edit", args: { path: "f", oldString: "a", newString: "b" }, detail: { type: "edit", filePath: "f", oldString: "a", newString: "b" } },
      { name: "write", args: { path: "f", content: "c" }, detail: { type: "write", filePath: "f", content: "c" } },
      {
        name: "grep",
        args: { pattern: "q" },
        detail: { type: "search", query: "q", toolName: "grep", content: undefined },
      },
      {
        name: "mystery",
        args: { x: 1 },
        detail: { type: "unknown", input: { args: { x: 1 } }, output: {} },
      },
    ];
    for (const { name, args, detail } of cases) {
      const event: CursorSDKMessage = {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "c",
        name,
        status: "running",
        args,
      };
      assert.deepEqual((toTimelineItem(event, IDS) as { detail: unknown }).detail, detail, name);
    }
  });

  it("maps task text to an info notification and drops empty task events", () => {
    const event: CursorSDKMessage = { type: "task", agent_id: "a", run_id: "r", text: "working" };
    assert.deepEqual(toTimelineItem(event, IDS), {
      type: "notification",
      id: "item:1",
      level: "info",
      message: "working",
    });
    assert.equal(toTimelineItem({ type: "task", agent_id: "a", run_id: "r" }, IDS), null);
  });

  it("maps ERROR status to an error item with a default message", () => {
    assert.deepEqual(
      toTimelineItem({ type: "status", agent_id: "a", run_id: "r", status: "ERROR", message: "bad" }, IDS),
      { type: "error", id: "item:1", message: "bad" },
    );
    assert.deepEqual(
      toTimelineItem({ type: "status", agent_id: "a", run_id: "r", status: "ERROR" }, IDS),
      { type: "error", id: "item:1", message: "Cursor run failed" },
    );
    assert.equal(toTimelineItem({ type: "status", agent_id: "a", run_id: "r", status: "OK" }, IDS), null);
  });

  it("returns null for non-renderable event types", () => {
    const events: CursorSDKMessage[] = [
      { type: "system", agent_id: "a", run_id: "r" },
      { type: "user", agent_id: "a", run_id: "r", message: { role: "user", content: [] } },
      { type: "request", agent_id: "a", run_id: "r", request_id: "q" },
      { type: "usage", agent_id: "a", run_id: "r", usage: usage() },
    ];
    for (const event of events) {
      assert.equal(toTimelineItem(event, IDS), null, event.type);
    }
  });
});

describe("toUsage", () => {
  it("returns an empty object without usage", () => {
    assert.deepEqual(toUsage(undefined), {});
  });

  it("maps token fields", () => {
    assert.deepEqual(toUsage(usage()), { inputTokens: 10, cachedInputTokens: 30, outputTokens: 20 });
  });

  it("skips non-numeric fields", () => {
    const partial = { inputTokens: "10", outputTokens: 5 } as unknown as CursorTokenUsage;
    assert.deepEqual(toUsage(partial), { outputTokens: 5 });
  });
});

describe("toProviderModels / toProviderError / publishableConfig", () => {
  it("maps model list items with thinking options", () => {
    assert.deepEqual(
      toProviderModels([
        {
          id: "composer-2.5",
          displayName: "Composer",
          parameters: [{ id: "effort", displayName: "Effort", values: [] }],
        },
      ]),
      [
        {
          id: "composer-2.5",
          label: "Composer",
          description: undefined,
          aliases: undefined,
          thinkingOptions: [{ id: "effort", label: "Effort" }],
          defaultThinkingOptionId: undefined,
        },
      ],
    );
  });

  it("falls back to the model id as label", () => {
    assert.equal(toProviderModels([{ id: "m", displayName: "" }])[0]?.label, "m");
  });

  it("preserves error codes when present", () => {
    assert.deepEqual(toProviderError(Object.assign(new Error("nope"), { code: "bad_model_name" })), {
      message: "nope",
      code: "bad_model_name",
    });
    assert.deepEqual(toProviderError("plain"), { message: "plain" });
  });

  it("publishes config with the default mode and auto-review toggle", () => {
    const config = publishableConfig({ settings: {}, models: [] });
    assert.equal(config.mode, "agent");
    assert.equal(config.settings[0]?.id, "autoReview");
    assert.equal(config.settings[1]?.id, "fast");
  });
});
