/**
 * A signal that aborts when `parent` aborts or after `ms`, whichever comes first. It stands in
 * for AbortSignal.any([parent, AbortSignal.timeout(ms)]), which older browsers (Safari before
 * 17.4) lack: there the call throws before any request goes out. The timeout aborts with a
 * TimeoutError, as AbortSignal.timeout does.
 */
export function timeoutSignal(parent: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return controller.signal;
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException('The request took too long.', 'TimeoutError')),
    ms,
  );
  parent.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      controller.abort(parent.reason);
    },
    { once: true },
  );
  return controller.signal;
}
