/**
 * Stage timings (spec AC-PF-01): User Timing measures named `hrflow:<stage>`, readable by an opt-in
 * perf E2E. Only the stage name and the duration are recorded: never data, file names or counts.
 */
export type PerfStage = 'read' | 'upload' | 'sql' | 'write' | 'run';

export const PERF_PREFIX = 'hrflow:';

export function perfStart(): number {
  return performance.now();
}

/** Record `[start, now]` as one measure of `stage`. Timing is best effort and never fails a run. */
export function perfMeasure(stage: PerfStage, start: number): void {
  try {
    performance.measure(PERF_PREFIX + stage, { start, end: performance.now() });
  } catch {
    // An environment without User Timing: the run goes on unmeasured.
  }
}
