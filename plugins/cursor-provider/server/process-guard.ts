// The SDK's local executor is shipped as one line (`dist/cjs/867.js`, about 1MB).
// Node's fatal printer echoes that whole line before the error message, and
// Paseo keeps 16KB per log line, so a crash there records the bundle and
// `Node.js v…` and then exits. Every open session dies with it.
//
// Capture the exception first, log only the name, message, and short frames,
// and leave the process up. A background SDK failure must not take the plugin down.

const MAX_SUMMARY_CHARS = 500;
const MAX_FRAME_CHARS = 240;
const MAX_FRAMES = 8;

let installed = false;

/** Name, message, and `at file:line:col` frames. Drops the executor's source line. */
export function summarizeProcessError(error: unknown): string {
  if (!(error instanceof Error)) return clip(String(error));
  const head = clip(`${error.name}: ${error.message}`);
  const frames = (error.stack ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trimStart().startsWith("at ") && line.length <= MAX_FRAME_CHARS)
    .slice(0, MAX_FRAMES);
  return frames.length > 0 ? `${head}\n${frames.join("\n")}` : head;
}

export function installProviderProcessGuard(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error(`cursor-sdk provider: unhandled rejection: ${summarizeProcessError(reason)}`);
  });
  process.setUncaughtExceptionCaptureCallback((error) => {
    console.error(`cursor-sdk provider: uncaught exception: ${summarizeProcessError(error)}`);
  });
}

function clip(text: string): string {
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
}
