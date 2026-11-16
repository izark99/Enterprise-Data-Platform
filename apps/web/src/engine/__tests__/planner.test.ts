import { type FlowDefinition, FlowDefinitionSchema, SelectConfigSchema } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/errors';
import { planFlow } from '../core/planner';
import type { ConfigSchema, NodePlugin, NodeRegistry } from '../nodes/index';

const anyConfig: ConfigSchema<unknown> = { safeParse: (input) => ({ success: true, data: input }) };

const plugin = (type: string, inputs: string[], outputs: string[]): NodePlugin => ({
  type,
  configSchema: anyConfig,
  ports: {
    inputs: inputs.map((name) => ({ name, required: true })),
    outputs: outputs.map((name) => ({ name, required: false })),
  },
  inferSchema: () => ({}),
  execute: () => ({}),
});

const REGISTRY: NodeRegistry = {
  'test.source': plugin('test.source', [], ['out']),
  'test.pass': plugin('test.pass', ['in'], ['out']),
  'test.pair': plugin('test.pair', ['left', 'right'], ['out']),
  'test.sink': plugin('test.sink', ['in'], []),
};

/** Builds the flow without `FlowDefinitionSchema`, which already rejects a cycle itself. */
const flow = (
  nodes: [id: string, type: string][],
  edges: FlowDefinition['edges'] = [],
): FlowDefinition => ({
  schemaVersion: 1,
  params: [],
  inputSlots: [],
  nodes: nodes.map(([id, type]) => ({ id, type, config: {} })),
  edges,
});

function planError(def: FlowDefinition, registry: NodeRegistry = REGISTRY): EngineError {
  try {
    planFlow(def, registry);
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
  throw new Error('planFlow did not throw');
}

describe('planFlow', () => {
  it('orders nodes topologically, ties in flow order, and wires the ports', () => {
    const plan = planFlow(
      flow(
        [
          ['sink', 'test.sink'],
          ['pair', 'test.pair'],
          ['b', 'test.source'],
          ['a', 'test.source'],
        ],
        [
          { from: 'pair', to: 'sink' },
          { from: 'a', to: 'pair', toPort: 'left' },
          { from: 'b', fromPort: 'out', to: 'pair', toPort: 'right' },
        ],
      ),
      REGISTRY,
    );
    expect(plan.map((p) => p.node.id)).toEqual(['b', 'a', 'pair', 'sink']);
    expect(plan[2]?.inputs).toEqual([
      { port: 'left', from: 'a', fromPort: 'out' },
      { port: 'right', from: 'b', fromPort: 'out' },
    ]);
  });

  it('rejects a cycle with executor.error.cycle at a node on the cycle', () => {
    const err = planError(
      flow(
        [
          ['src', 'test.source'],
          ['x', 'test.pair'],
          ['y', 'test.pass'],
          ['after', 'test.sink'],
        ],
        [
          { from: 'src', to: 'x', toPort: 'left' },
          { from: 'y', to: 'x', toPort: 'right' },
          { from: 'x', to: 'y' },
          { from: 'y', to: 'after' },
        ],
      ),
    );
    expect(err.messageKey).toBe('executor.error.cycle');
    expect(['x', 'y']).toContain(err.nodeId);
    expect(err.params).toEqual({ node: err.nodeId });
  });

  it('rejects a missing required port with executor.error.missingPort', () => {
    const err = planError(
      flow(
        [
          ['a', 'test.source'],
          ['pair', 'test.pair'],
        ],
        [{ from: 'a', to: 'pair', toPort: 'left' }],
      ),
    );
    expect(err.messageKey).toBe('executor.error.missingPort');
    expect(err.nodeId).toBe('pair');
    expect(err.params).toEqual({ node: 'pair', port: 'right' });
  });

  it('rejects an unknown node type with executor.error.unknownNodeType', () => {
    const err = planError(flow([['n', 'test.nope']]));
    expect(err.messageKey).toBe('executor.error.unknownNodeType');
    expect(err.nodeId).toBe('n');
    expect(err.params).toEqual({ type: 'test.nope' });
    // A plugin with neither `execute` nor `compile` cannot run either.
    const noRun: NodePlugin = { ...plugin('test.empty', [], ['out']), execute: undefined };
    const empty = planError(flow([['e', 'test.empty']]), { 'test.empty': noRun });
    expect(empty.messageKey).toBe('executor.error.unknownNodeType');
  });

  it('rejects bad wiring with its own key', () => {
    const two = [
      ['a', 'test.source'] as [string, string],
      ['pair', 'test.pair'] as [string, string],
    ];
    expect(planError(flow(two, [{ from: 'a', to: 'pair' }])).messageKey).toBe(
      'executor.error.ambiguousPort',
    );
    expect(planError(flow(two, [{ from: 'a', to: 'pair', toPort: 'middle' }])).params).toEqual({
      node: 'pair',
      port: 'middle',
    });
    expect(
      planError(
        flow(two, [
          { from: 'a', to: 'pair', toPort: 'left' },
          { from: 'a', to: 'pair', toPort: 'left' },
        ]),
      ).messageKey,
    ).toBe('executor.error.portConnectedTwice');
    expect(planError(flow(two, [{ from: 'ghost', to: 'pair' }])).messageKey).toBe(
      'executor.error.unknownNode',
    );
    expect(
      planError(
        flow([
          ['a', 'test.source'],
          ['a', 'test.source'],
        ]),
      ).messageKey,
    ).toBe('executor.error.duplicateNode');
  });

  it('parses the config with the plugin schema and reports the first invalid field', () => {
    const select: NodePlugin = {
      ...plugin('test.select', ['in'], ['out']),
      configSchema: SelectConfigSchema,
    };
    const def = FlowDefinitionSchema.parse({
      schemaVersion: 1,
      nodes: [
        { id: 'src', type: 'test.source' },
        { id: 'sel', type: 'test.select', label: 'Chọn cột', config: { columns: [{ key: 1 }] } },
      ],
      edges: [{ from: 'src', to: 'sel' }],
    });
    const err = planError(def, { ...REGISTRY, 'test.select': select });
    expect(err.messageKey).toBe('executor.error.invalidConfig');
    expect(err.nodeId).toBe('sel');
    expect(err.path?.[0]).toBe('columns');
    expect(err.params.node).toBe('Chọn cột');
  });

  it('uses config-dependent input ports and reports checkConfig problems at the node', () => {
    const dynamic: NodePlugin = {
      ...plugin('test.dynamic', [], []),
      inputPorts: (config) =>
        ((config as { ports: string[] }).ports ?? []).map((name) => ({
          name,
          required: true,
        })),
      checkConfig: (config) =>
        (config as { bad?: boolean }).bad
          ? [new EngineError('dynamic.error.bad', {}, { path: ['bad'] })]
          : [],
    };
    const registry = { ...REGISTRY, 'test.dynamic': dynamic };
    const base = flow([
      ['a', 'test.source'],
      ['d', 'test.dynamic'],
    ]);
    const withConfig = (config: Record<string, unknown>): FlowDefinition => ({
      ...base,
      nodes: [base.nodes[0]!, { id: 'd', type: 'test.dynamic', config }],
      edges: [{ from: 'a', to: 'd', toPort: 'sheet_1' }],
    });
    expect(planFlow(withConfig({ ports: ['sheet_1'] }), registry)[1]?.inputPorts).toEqual([
      { name: 'sheet_1', required: true },
    ]);
    const err = planError(withConfig({ ports: ['sheet_1'], bad: true }), registry);
    expect(err.messageKey).toBe('dynamic.error.bad');
    expect(err.nodeId).toBe('d');
    expect(err.path).toEqual(['bad']);
  });
});
