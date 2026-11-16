import { z } from 'zod';
import { IdentifierSchema } from './identifier';
import { FlowParamSchema } from './params';
import { InputSlotSchema } from './slots';

/**
 * Flow definition (spec §8, docs/redesign/03 §3). A node's `config` is checked by its plugin
 * against the schema of `nodes.ts` / `transforms.ts`, not here.
 */

const PointSchema = z.tuple([z.number().finite(), z.number().finite()]);

/** Canvas-only data; the engine ignores it and version diffs skip it (spec §8). */
export const FlowUiSchema = z.strictObject({
  positions: z.record(z.string(), PointSchema).default({}),
  notes: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        text: z.string(),
        position: PointSchema,
        size: PointSchema.optional(),
      }),
    )
    .default([]),
});
export type FlowUi = z.infer<typeof FlowUiSchema>;

export const FlowNodeSchema = z.strictObject({
  id: IdentifierSchema,
  /** Plugin type, e.g. `input.excel`, `control.compare`. */
  type: z.string().regex(/^[a-z]+\.[a-zA-Z]+$/, 'must look like "group.name"'),
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.strictObject({
  from: IdentifierSchema,
  fromPort: z.string().min(1).optional(),
  to: IdentifierSchema,
  toPort: z.string().min(1).optional(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

/**
 * True when the graph has a cycle (Kahn's algorithm). Repeated ids count once and edges to unknown
 * nodes are ignored: those failures have their own issues.
 */
export function hasCycle(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): boolean {
  const ids = [...new Set(nodeIds)];
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    next.get(edge.from)?.push(edge.to);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  let visited = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    visited += 1;
    for (const to of next.get(id) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, left);
      if (left === 0) ready.push(to);
    }
  }
  return visited !== ids.length;
}

export const FlowDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    params: z.array(FlowParamSchema).default([]),
    inputSlots: z.array(InputSlotSchema).default([]),
    nodes: z.array(FlowNodeSchema).min(1),
    edges: z.array(FlowEdgeSchema).default([]),
    ui: FlowUiSchema.optional(),
  })
  .superRefine((flow, ctx) => {
    const ids = new Set<string>();
    flow.nodes.forEach((node, i) => {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', i, 'id'],
          message: `duplicate node id "${node.id}"`,
        });
      }
      ids.add(node.id);
    });
    flow.edges.forEach((edge, i) => {
      for (const end of ['from', 'to'] as const) {
        if (!ids.has(edge[end])) {
          ctx.addIssue({
            code: 'custom',
            path: ['edges', i, end],
            message: `unknown node "${edge[end]}"`,
          });
        }
      }
    });
    const slotKeys = new Set<string>();
    flow.inputSlots.forEach((slot, i) => {
      if (slotKeys.has(slot.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputSlots', i, 'key'],
          message: `duplicate slot key "${slot.key}"`,
        });
      }
      slotKeys.add(slot.key);
    });
    if (
      hasCycle(
        flow.nodes.map((node) => node.id),
        flow.edges,
      )
    ) {
      ctx.addIssue({ code: 'custom', path: ['edges'], message: 'the flow graph must be acyclic' });
    }
  });
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type FlowDefinitionInput = z.input<typeof FlowDefinitionSchema>;
