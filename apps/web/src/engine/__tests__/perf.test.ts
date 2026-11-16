import { describe, expect, it } from 'vitest';
import { PERF_PREFIX, perfMeasure, perfStart } from '../core/perf';

describe('perf', () => {
  it('records a User Timing measure named by the stage only', () => {
    performance.clearMeasures(`${PERF_PREFIX}read`);
    perfMeasure('read', perfStart());
    const entries = performance.getEntriesByName(`${PERF_PREFIX}read`, 'measure');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('hrflow:read');
  });
});
