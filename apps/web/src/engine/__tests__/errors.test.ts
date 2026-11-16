import { describe, expect, it } from 'vitest';
import { EngineError, isEngineError } from '../core/errors';

describe('EngineError (07 §6)', () => {
  it('carries the key, variables, node id and field path; the message is the key only', () => {
    const err = new EngineError(
      'join.error.keyTypeMismatch',
      { column: 'ma_nv', count: 2 },
      { nodeId: 'join_1', path: ['keys', 0, 'left'] },
    );
    expect(err.message).toBe('join.error.keyTypeMismatch');
    expect(err.toInfo()).toEqual({
      messageKey: 'join.error.keyTypeMismatch',
      params: { column: 'ma_nv', count: 2 },
      nodeId: 'join_1',
      path: ['keys', 0, 'left'],
    });
    expect(isEngineError(err)).toBe(true);
    expect(isEngineError(new Error('x'))).toBe(false);
  });

  it('attaches a node id once', () => {
    const bare = new EngineError('sort.error.unknownColumn', {}, { path: ['by', 0] });
    const attached = bare.atNode('sort_1');
    expect(attached.nodeId).toBe('sort_1');
    expect(attached.path).toEqual(['by', 0]);
    expect(attached.atNode('other').nodeId).toBe('sort_1');
    expect(new EngineError('a.error.b').toInfo()).toEqual({ messageKey: 'a.error.b', params: {} });
  });
});
