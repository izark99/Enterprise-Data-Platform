import { describe, expect, it } from 'vitest';
import { NODE_PLUGINS } from '../nodes/index';

describe('node registry', () => {
  it('registers the plugins of the acceptance flow, the transform nodes and code.sql under their type', () => {
    expect(Object.keys(NODE_PLUGINS)).toEqual([
      'input.excel',
      'control.compare',
      'output.excel',
      'output.preview',
      'transform.select',
      'transform.filter',
      'transform.sort',
      'transform.join',
      'transform.union',
      'transform.groupBy',
      'transform.dedupe',
      'code.sql',
    ]);
    for (const [type, plugin] of Object.entries(NODE_PLUGINS)) expect(plugin.type).toBe(type);
  });
});
