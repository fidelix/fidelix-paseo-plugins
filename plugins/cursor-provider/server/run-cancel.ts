/**
 * The SDK's local `run.cancel()` flips the run to `cancelled` synchronously,
 * then writes CANCELLED to the store. A second call returns at once, before
 * that write lands, so a caller that waits on it and then sends hits
 * "Agent … already has active run". Every caller shares the first call.
 */
const inFlight = new WeakMap<object, Promise<void>>();

export function cancelRun(run: { cancel(): Promise<void> }): Promise<void> {
  let pending = inFlight.get(run);
  if (!pending) {
    pending = run.cancel().then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(run, pending);
  }
  return pending;
}
