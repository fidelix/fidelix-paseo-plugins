import type { CursorSdkErrorShape } from "./cursor-sdk-types.js";

/**
 * Retriable-failure classification for Cursor SDK runs.
 *
 * The SDK marks errors with `isRetryable` from the backend's retry flag, but
 * that flag is not always present (transport failures can surface without
 * it). This classifier combines the SDK signal with stable error codes so a
 * transient failure does not silently end a turn:
 *
 * - Retry: `isRetryable === true`, RateLimitError family (429 incl.
 *   `resource_exhausted` / usage-limit quota errors), NetworkError family
 *   (5xx / timeout / unavailable).
 * - Never retry: auth/config errors (401 bad key, 400/404 bad model or
 *   params), AgentBusyError (409, needs user intervention), cancellations.
 *
 * `resource_exhausted` IS retried: Cursor quota/rate-limit errors are
 * transient capacity signals and resolve once capacity frees. A bare 404
 * (unknown model/deployment, e.g. the ACP "trouble finding the resource you
 * requested" failure) is NOT retried: resending the same model against a
 * missing deployment fails identically. The fix for a 404 is switching
 * models, not resending.
 */

const RETRYABLE_CODES = new Set([
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
  "unavailable",
  "deadline_exceeded",
  "internal",
]);

const NON_RETRYABLE_CODES = new Set([
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
]);

export interface ClassifiedError {
  message: string;
  code?: string;
  retryable: boolean;
}

function readCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

function readRetryableFlag(error: unknown): boolean | undefined {
  if (error !== null && typeof error === "object") {
    const flag = Reflect.get(error, "isRetryable");
    if (typeof flag === "boolean") return flag;
  }
  return undefined;
}

export function classifyCursorError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const raw = readCode(error) ?? (error as CursorSdkErrorShape | null)?.code;
  const code = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  const normalized = code?.toLowerCase();
  if (normalized && NON_RETRYABLE_CODES.has(normalized)) {
    return { message, code, retryable: false };
  }
  if (normalized && RETRYABLE_CODES.has(normalized)) {
    return { message, code, retryable: true };
  }
  const flag = readRetryableFlag(error);
  if (flag !== undefined) return { message, code, retryable: flag };
  return { message, code, retryable: false };
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

/**
 * Backoff between attempts: exponential doubling from baseDelayMs capped at
 * maxDelayMs — the same shape as Paseo's own reconnect/retry waits
 * (relay-transport caps at 30s; opencode stop-status polling doubles with a
 * cap). No jitter: provider retries are low-frequency and user-visible.
 */
export function retryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Retry wait aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("Retry wait aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
