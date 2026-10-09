// Zero-spend unit tests for server/retry.ts (pure classifier + backoff).
// Run: node --test server/retry.test.ts
// No SDK imports, no network, no timers beyond a few ms.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: `.ts` specifier required so node --test type-stripping resolves it (tsc Bundler mode maps extensionless/`.js`)
import { DEFAULT_RETRY_POLICY, classifyCursorError, retryDelayMs, sleep } from "./retry.ts";
// @ts-expect-error: same `.ts` specifier exemption for the sibling helper under test
import { toProviderError } from "./mapping.ts";

const RETRYABLE_CODES = [
  "resource_exhausted",
  "rate_limited",
  "rate_limited_changeable",
  "free_user_rate_limit_exceeded",
  "pro_user_rate_limit_exceeded",
  "free_user_usage_limit",
  "pro_user_usage_limit",
  "generic_rate_limit_exceeded",
  "gpt_4_vision_preview_rate_limit",
  "api_key_rate_limit",
  "openai_rate_limit_exceeded",
  "rate_limit_exceeded",
  "timeout",
  "deadline_exceeded",
  "unavailable",
  "internal",
];

const NON_RETRYABLE_CODES = [
  "unauthenticated",
  "not_found",
  "invalid_argument",
  "bad_api_key",
  "bad_user_api_key",
  "bad_model_name",
  "bad_request",
  "model_blocked",
  "deprecated",
  "agent_busy",
  "canceled",
  "cancelled",
];

describe("classifyCursorError", () => {
  for (const code of RETRYABLE_CODES) {
    it(`retries ${code}`, () => {
      assert.equal(classifyCursorError({ code }).retryable, true);
    });
  }

  it("matches retryable codes case-insensitively", () => {
    for (const code of ["Resource_Exhausted", "TIMEOUT", "Rate_Limited", "INTERNAL", "Unavailable"]) {
      const out = classifyCursorError({ code });
      assert.equal(out.retryable, true, code);
      assert.equal(out.code, code);
    }
  });

  for (const code of NON_RETRYABLE_CODES) {
    it(`does not retry ${code}`, () => {
      assert.equal(classifyCursorError({ code }).retryable, false);
    });
  }

  it("never retries non-retryable codes even when isRetryable is true", () => {
    for (const code of ["agent_busy", "canceled", "cancelled", "unauthenticated", "not_found", "bad_model_name"]) {
      assert.equal(classifyCursorError({ code, isRetryable: true }).retryable, false, code);
    }
  });

  it("retries retryable codes even when isRetryable is false", () => {
    assert.equal(classifyCursorError({ code: "timeout", isRetryable: false }).retryable, true);
    assert.equal(classifyCursorError({ code: "resource_exhausted", isRetryable: false }).retryable, true);
  });

  it("falls back to the isRetryable flag for unknown codes", () => {
    assert.equal(classifyCursorError({ code: "some_future_code", isRetryable: true }).retryable, true);
    assert.equal(classifyCursorError({ code: "some_future_code", isRetryable: false }).retryable, false);
    const flagged = Object.assign(new Error("flagged"), { isRetryable: true });
    assert.equal(classifyCursorError(flagged).retryable, true);
  });

  it("defaults unknown errors to non-retryable", () => {
    assert.equal(classifyCursorError({ code: "some_future_code" }).retryable, false);
    assert.equal(classifyCursorError({}).retryable, false);
    assert.equal(classifyCursorError({ code: "" }).retryable, false);
    assert.equal(classifyCursorError({ code: "" }).code, undefined);
    assert.equal(classifyCursorError(new Error("boom")).retryable, false);
    assert.equal(classifyCursorError("plain string").retryable, false);
    assert.equal(classifyCursorError(null).retryable, false);
    assert.equal(classifyCursorError(undefined).retryable, false);
  });

  it("does not retry plain-object run errors without codes", () => {
    // run.wait() failures arrive as `{ message }` with no code: no retry,
    // but the message must survive (no "[object Object]").
    const out = classifyCursorError({ message: "AI Model Not Found" });
    assert.equal(out.retryable, false);
    assert.equal(out.message, "AI Model Not Found");
    assert.deepEqual(toProviderError({ message: "AI Model Not Found" }), { message: "AI Model Not Found" });
  });

  it("preserves message and code", () => {
    const err = Object.assign(new Error("rate limited, slow down"), { code: "rate_limited" });
    const out = classifyCursorError(err);
    assert.equal(out.message, "rate limited, slow down");
    assert.equal(out.code, "rate_limited");
    assert.equal(out.retryable, true);
    assert.equal(classifyCursorError("plain string").message, "plain string");
  });
});

describe("retryDelayMs", () => {
  it("doubles from the base delay and caps at maxDelayMs", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt)),
      [1000, 2000, 4000, 8000, 15000, 15000, 15000],
    );
  });

  it("exposes the documented default policy", () => {
    assert.deepEqual(DEFAULT_RETRY_POLICY, { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 15000 });
  });

  it("honors a custom policy", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 1200 };
    assert.equal(retryDelayMs(1, policy), 500);
    assert.equal(retryDelayMs(2, policy), 1000);
    assert.equal(retryDelayMs(3, policy), 1200);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    assert.equal(await sleep(1), undefined);
  });

  it("rejects when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => sleep(1000, controller.signal), /aborted/i);
  });

  it("rejects when aborted mid-wait", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await assert.rejects(() => pending, /aborted/i);
  });
});
