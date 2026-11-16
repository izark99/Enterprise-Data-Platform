import { describe, expect, it } from 'vitest';
import { NODE_PLUGINS } from '../nodes/index';

describe('node registry', () => {
  it('is empty until node tasks register plugins', () => {
    expect(Object.keys(NODE_PLUGINS)).toEqual([]);
  });
});
