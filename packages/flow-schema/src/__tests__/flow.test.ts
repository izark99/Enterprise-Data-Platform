import { describe, expect, it } from 'vitest';
import payrollFlow from '../../../../fixtures/payroll-timesheet/flow.json';
import { FlowDefinitionSchema, hasCycle } from '../flow';

const node = (id: string) => ({ id, type: 'transform.select', config: {} });
const minimal = { schemaVersion: 1, nodes: [node('a')] };

function issuePaths(input: unknown): PropertyKey[][] {
  const result = FlowDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

describe('FlowDefinitionSchema', () => {
  it('parses the acceptance flow fixture', () => {
    const result = FlowDefinitionSchema.safeParse(payrollFlow);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data?.nodes.map((n) => n.id)).toEqual(['in_luong', 'in_cc', 'cmp', 'out']);
  });

  it('fills the defaults of a minimal flow', () => {
    expect(
      FlowDefinitionSchema.parse({ schemaVersion: 1, nodes: [{ id: 'a', type: 'x.y' }] }),
    ).toEqual({
      schemaVersion: 1,
      params: [],
      inputSlots: [],
      nodes: [{ id: 'a', type: 'x.y', config: {} }],
      edges: [],
    });
  });

  it('fills ui positions and notes', () => {
    expect(FlowDefinitionSchema.parse({ ...minimal, ui: {} }).ui).toEqual({
      positions: {},
      notes: [],
    });
    const ui = {
      positions: { a: [10, 20] },
      notes: [{ id: 'n1', text: 'Ghi chú', position: [0, 0], size: [200, 100] }],
    };
    expect(FlowDefinitionSchema.parse({ ...minimal, ui }).ui).toEqual(ui);
  });

  it('rejects another schemaVersion, no node, and an unknown field', () => {
    expect(FlowDefinitionSchema.safeParse({ ...minimal, schemaVersion: 2 }).success).toBe(false);
    expect(FlowDefinitionSchema.safeParse({ ...minimal, nodes: [] }).success).toBe(false);
    expect(FlowDefinitionSchema.safeParse({ ...minimal, extra: true }).success).toBe(false);
  });
});

describe('FlowDefinitionSchema invariants (one issue path each)', () => {
  it('duplicate node id', () => {
    expect(issuePaths({ ...minimal, nodes: [node('a'), node('b'), node('a')] })).toEqual([
      ['nodes', 2, 'id'],
    ]);
  });

  it('edge to an unknown node', () => {
    expect(issuePaths({ ...minimal, edges: [{ from: 'a', to: 'zz' }] })).toEqual([
      ['edges', 0, 'to'],
    ]);
    expect(issuePaths({ ...minimal, edges: [{ from: 'zz', to: 'a' }] })).toEqual([
      ['edges', 0, 'from'],
    ]);
  });

  it('duplicate slot key', () => {
    const slot = {
      key: 's',
      label: 'S',
      columns: [{ key: 'k', aliases: ['K'], type: 'string' }],
    };
    expect(issuePaths({ ...minimal, inputSlots: [slot, slot] })).toEqual([
      ['inputSlots', 1, 'key'],
    ]);
  });

  it('cycle', () => {
    expect(
      issuePaths({
        ...minimal,
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'b' },
        ],
      }),
    ).toEqual([['edges']]);
  });
});

describe('hasCycle', () => {
  it('finds a self loop and accepts a diamond', () => {
    expect(hasCycle(['a'], [{ from: 'a', to: 'a' }])).toBe(true);
    expect(
      hasCycle(
        ['a', 'b', 'c', 'd'],
        [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'd' },
          { from: 'c', to: 'd' },
        ],
      ),
    ).toBe(false);
  });
});
