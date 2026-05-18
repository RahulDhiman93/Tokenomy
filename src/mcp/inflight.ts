// 0.1.10+ P4: MCP concurrency cap + per-tool deadline.
//
// Inflight cap: at most `max` parallel acquires can hold a slot. When
// the cap is reached `acquire()` returns null instead of queueing —
// the caller surfaces `{ok:false, code:"busy", retry_after_ms}` so
// the agent backs off and retries via its own retry logic.
//
// Deadline: `withDeadline(fn, ms)` races the inner work against a
// monotonic timer. Timeout returns a structured payload instead of
// silently letting the inner work run to completion.

export interface InflightSlot {
  release(): void;
}

let inflight = 0;
let max = 8;

export const configureInflight = (m: number): void => {
  if (Number.isFinite(m) && m > 0) max = Math.floor(m);
};

export const acquire = (): InflightSlot | null => {
  if (inflight >= max) return null;
  inflight++;
  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      inflight = Math.max(0, inflight - 1);
    },
  };
};

export const inflightCount = (): number => inflight;
export const inflightMax = (): number => max;

// Test affordance — drop state between cases.
export const _resetInflightForTests = (): void => {
  inflight = 0;
};

export type DeadlineResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout"; elapsed_ms: number };

export const withDeadline = async <T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<DeadlineResult<T>> => {
  const start = performance.now();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout", elapsed_ms: Math.round(performance.now() - start) });
    }, ms);
  });
  try {
    const work = (async (): Promise<DeadlineResult<T>> => ({
      kind: "ok",
      value: await fn(),
    }))();
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};
