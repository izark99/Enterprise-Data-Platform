import type { FlowDefinition } from '@hrflow/flow-schema';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/errors';
import { executePlan, type RunProgressEvent } from '../core/executor';
import { planFlow } from '../core/planner';
import { Table } from '../core/table';
import type { ConfigSchema, NodePlugin, NodeRegistry } from '../nodes/index';

const anyConfig: ConfigSchema<unknown> = { safeParse: (input) => ({ success: true, data: input }) };
const COLUMNS = [{ key: 'n', title: 'N', type: 'integer' as const }];
const tableOf = (count: number): Table =>
  Table.fromRows(
    COLUMNS,
    Array.from({ length: count }, (_, i) => [i]),
  );

/** Spy plugins: each run records, per node, which tables were already released when it started. */
function spyRegistry(log: { node: string; released: string[] }[], made: Map<string, Table>) {
  const snapshot = (node: string): void => {
    log.push({
      node,
      released: [...made].filter(([, t]) => t.released).map(([id]) => id),
    });
  };
  const ports = (inputs: string[], outputs: string[]) => ({
    inputs: inputs.map((name) => ({ name, required: true })),
    outputs: outputs.map((name) => ({ name, required: false })),
  });
  const registry: NodeRegistry = {
    'spy.source': {
      type: 'spy.source',
      configSchema: anyConfig,
      ports: ports([], ['out']),
      inferSchema: () => ({ out: COLUMNS }),
      execute: (config, _inputs, ctx) => {
        snapshot(ctx.nodeId);
        const table = tableOf((config as { rows: number }).rows);
        made.set(ctx.nodeId, table);
        return { out: table };
      },
    },
    'spy.pass': {
      type: 'spy.pass',
      configSchema: anyConfig,
      ports: ports(['in'], ['out']),
      inferSchema: (_c, inputs) => ({ out: inputs.in ?? [] }),
      execute: (_config, inputs, ctx) => {
        snapshot(ctx.nodeId);
        const table = inputs.in!.slice(0, 2);
        made.set(ctx.nodeId, table);
        return { out: table };
      },
    },
    'spy.same': {
      type: 'spy.same',
      configSchema: anyConfig,
      ports: ports(['in'], ['out']),
      inferSchema: (_c, inputs) => ({ out: inputs.in ?? [] }),
      execute: (_config, inputs, ctx) => {
        snapshot(ctx.nodeId);
        return { out: inputs.in! };
      },
    },
    'spy.pair': {
      type: 'spy.pair',
      configSchema: anyConfig,
      ports: ports(['left', 'right'], ['out']),
      inferSchema: () => ({ out: COLUMNS }),
      execute: (_config, inputs, ctx) => {
        snapshot(ctx.nodeId);
        const table = tableOf(inputs.left!.rowCount + inputs.right!.rowCount);
        made.set(ctx.nodeId, table);
        return { out: table };
      },
    },
  };
  return registry;
}

const flow = (
  nodes: [id: string, type: string, config?: Record<string, unknown>][],
  edges: FlowDefinition['edges'],
): FlowDefinition => ({
  schemaVersion: 1,
  params: [],
  inputSlots: [],
  nodes: nodes.map(([id, type, config]) => ({ id, type, config: config ?? {} })),
  edges,
});

describe('executePlan', () => {
  it('releases each intermediate table as soon as no later node reads it', async () => {
    const log: { node: string; released: string[] }[] = [];
    const made = new Map<string, Table>();
    // a ──► pass_a ──► pair ◄── b,  and a is also read by pair_late at the end.
    const def = flow(
      [
        ['a', 'spy.source', { rows: 5 }],
        ['b', 'spy.source', { rows: 3 }],
        ['pass_a', 'spy.pass'],
        ['pair', 'spy.pair'],
        ['pair_late', 'spy.pair'],
      ],
      [
        { from: 'a', to: 'pass_a' },
        { from: 'pass_a', to: 'pair', toPort: 'left' },
        { from: 'b', to: 'pair', toPort: 'right' },
        { from: 'pair', to: 'pair_late', toPort: 'left' },
        { from: 'a', to: 'pair_late', toPort: 'right' },
      ],
    );
    const events: RunProgressEvent[] = [];
    const result = await executePlan(def, planFlow(def, spyRegistry(log, made)), {
      onProgress: (e) => events.push(e),
    });

    expect(log).toEqual([
      { node: 'a', released: [] },
      { node: 'b', released: [] },
      { node: 'pass_a', released: [] },
      // pass_a's output is still needed by pair; a still by pair_late.
      { node: 'pair', released: [] },
      // pair read pass_a and b for the last time: both released before pair_late runs.
      { node: 'pair_late', released: ['b', 'pass_a'] },
    ]);
    expect(made.get('a')?.released).toBe(true);
    expect(made.get('pair')?.released).toBe(true);
    // The table no node reads is the result, not released.
    const out = result.outputs.pair_late?.out;
    expect(out?.released).toBe(false);
    expect(out?.rowCount).toBe(2 + 3 + 5);

    const finished = events.filter((e) => e.type === 'node-finished');
    expect(finished.map((e) => [e.nodeId, e.rows])).toEqual([
      ['a', { out: 5 }],
      ['b', { out: 3 }],
      ['pass_a', { out: 2 }],
      ['pair', { out: 5 }],
      ['pair_late', { out: 10 }],
    ]);
    expect(events.filter((e) => e.type === 'node-started')).toHaveLength(5);
  });

  it('does not release a table a plugin passes through while a later node reads it', async () => {
    const log: { node: string; released: string[] }[] = [];
    const made = new Map<string, Table>();
    const def = flow(
      [
        ['a', 'spy.source', { rows: 4 }],
        ['same', 'spy.same'],
        ['pass', 'spy.pass'],
      ],
      [
        { from: 'a', to: 'same' },
        { from: 'same', to: 'pass' },
      ],
    );
    const result = await executePlan(def, planFlow(def, spyRegistry(log, made)));
    expect(log.map((l) => l.released)).toEqual([[], [], []]);
    expect(made.get('a')?.released).toBe(true);
    expect(result.outputs.pass?.out?.rowCount).toBe(2);
  });

  it('stops on the first error, names the node, hides foreign messages and frees tables', async () => {
    const made = new Map<string, Table>();
    const registry: NodeRegistry = {
      ...spyRegistry([], made),
      'spy.boom': {
        type: 'spy.boom',
        configSchema: anyConfig,
        ports: { inputs: [{ name: 'in', required: true }], outputs: [] },
        inferSchema: () => ({}),
        execute: (config) => {
          if ((config as { engine?: boolean }).engine) {
            throw new EngineError('boom.error.bad', { count: 1 });
          }
          throw new Error('cell value NV001 leaked');
        },
      } satisfies NodePlugin,
    };
    const ran: string[] = [];
    const run = (engine: boolean) => {
      const def = flow(
        [
          ['a', 'spy.source', { rows: 2 }],
          ['boom', 'spy.boom', { engine }],
          ['after', 'spy.pass'],
        ],
        [
          { from: 'a', to: 'boom' },
          { from: 'a', to: 'after' },
        ],
      );
      return executePlan(def, planFlow(def, registry), {
        onProgress: (e) => {
          if (e.type === 'node-started') ran.push(e.nodeId);
        },
      });
    };

    const foreign = await run(false).catch((err: unknown) => err);
    expect(foreign).toBeInstanceOf(EngineError);
    expect((foreign as EngineError).toInfo()).toEqual({
      messageKey: 'executor.error.nodeFailed',
      params: { node: 'boom' },
      nodeId: 'boom',
    });
    expect(String((foreign as Error).message)).not.toContain('NV001');
    expect(ran).toEqual(['a', 'boom']);
    expect(made.get('a')?.released).toBe(true);

    const own = await run(true).catch((err: unknown) => err);
    expect((own as EngineError).toInfo()).toEqual({
      messageKey: 'boom.error.bad',
      params: { count: 1 },
      nodeId: 'boom',
    });
  });

  it('reports a consumed output port the plugin did not produce', async () => {
    const registry: NodeRegistry = {
      ...spyRegistry([], new Map()),
      'spy.nothing': {
        type: 'spy.nothing',
        configSchema: anyConfig,
        ports: { inputs: [], outputs: [{ name: 'out', required: false }] },
        inferSchema: () => ({}),
        execute: () => ({}),
      },
    };
    const def = flow(
      [
        ['n', 'spy.nothing'],
        ['p', 'spy.pass'],
      ],
      [{ from: 'n', to: 'p' }],
    );
    const err = await executePlan(def, planFlow(def, registry)).catch((e: unknown) => e);
    expect((err as EngineError).toInfo()).toEqual({
      messageKey: 'executor.error.missingInput',
      params: { node: 'p', port: 'in' },
      nodeId: 'p',
    });
  });
});
