import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_PACKAGE } from './index';

describe('flow-schema', () => {
  it('exposes its package name', () => {
    expect(FLOW_SCHEMA_PACKAGE).toBe('@hrflow/flow-schema');
  });
});
