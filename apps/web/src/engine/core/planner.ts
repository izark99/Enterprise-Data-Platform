import type { FlowDefinition, FlowNode } from '@hrflow/flow-schema';
import { NODE_PLUGINS, type NodePlugin, type NodeRegistry } from '../nodes/index';
import { EngineError } from './errors';
import type { PortDef } from './types';

/**
 * Planner (spec §13 step 3): resolves each node's plugin and config, wires ports and orders the
 * nodes topologically. The first problem is thrown as an `EngineError` (`executor.error.*`) that
 * names the node.
 */

/** One wired input port: `port` of this node reads `fromPort` of node `from`. */
export interface PortLink {
  readonly port: string;
  readonly from: string;
  readonly fromPort: string;
}

export interface PlannedNode {
  readonly node: FlowNode;
  readonly plugin: NodePlugin;
  /** Config parsed by the plugin schema (defaults applied). */
  readonly config: unknown;
  readonly inputPorts: readonly PortDef[];
  readonly outputPorts: readonly PortDef[];
  readonly inputs: readonly PortLink[];
}

const nodeName = (node: FlowNode): string => node.label ?? node.id;

function fail(key: string, params: Record<string, string>, nodeId: string): never {
  throw new EngineError(key, params, { nodeId });
}

function resolvePort(ports: readonly PortDef[], requested: string | undefined, node: FlowNode) {
  if (requested === undefined) {
    const only = ports.length === 1 ? ports[0] : undefined;
    if (only === undefined) fail('executor.error.ambiguousPort', { node: nodeName(node) }, node.id);
    return only.name;
  }
  if (!ports.some((p) => p.name === requested)) {
    fail('executor.error.unknownPort', { node: nodeName(node), port: requested }, node.id);
  }
  return requested;
}

export function planFlow(
  flow: FlowDefinition,
  registry: NodeRegistry = NODE_PLUGINS,
): PlannedNode[] {
  const byId = new Map<string, { node: FlowNode; plugin: NodePlugin; config: unknown }>();
  const ports = new Map<string, { inputs: readonly PortDef[]; outputs: readonly PortDef[] }>();
  const links = new Map<string, PortLink[]>();

  for (const node of flow.nodes) {
    if (byId.has(node.id)) fail('executor.error.duplicateNode', { node: node.id }, node.id);
    const plugin = registry[node.type];
    if (plugin === undefined || (!plugin.execute && !plugin.compile)) {
      fail('executor.error.unknownNodeType', { type: node.type }, node.id);
    }
    const parsed = plugin.configSchema.safeParse(node.config);
    if (!parsed.success) {
      const path = (parsed.error.issues[0]?.path ?? []).map(String);
      throw new EngineError(
        'executor.error.invalidConfig',
        { node: nodeName(node), path: path.join('.') },
        { nodeId: node.id, path },
      );
    }
    const problem = plugin.checkConfig?.(parsed.data, flow)[0];
    if (problem !== undefined) throw problem.atNode(node.id);
    byId.set(node.id, { node, plugin, config: parsed.data });
    ports.set(node.id, {
      inputs: plugin.inputPorts?.(parsed.data) ?? plugin.ports.inputs,
      outputs: plugin.ports.outputs,
    });
    links.set(node.id, []);
  }

  for (const edge of flow.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined) fail('executor.error.unknownNode', { node: edge.from }, edge.from);
    if (to === undefined) fail('executor.error.unknownNode', { node: edge.to }, edge.to);
    const fromPort = resolvePort(ports.get(from.node.id)!.outputs, edge.fromPort, from.node);
    const port = resolvePort(ports.get(to.node.id)!.inputs, edge.toPort, to.node);
    const into = links.get(to.node.id)!;
    if (into.some((l) => l.port === port)) {
      fail('executor.error.portConnectedTwice', { node: nodeName(to.node), port }, to.node.id);
    }
    into.push({ port, from: from.node.id, fromPort });
  }

  for (const { node } of byId.values()) {
    for (const port of ports.get(node.id)!.inputs) {
      if (port.required && !links.get(node.id)!.some((l) => l.port === port.name)) {
        fail('executor.error.missingPort', { node: nodeName(node), port: port.name }, node.id);
      }
    }
  }

  return topologicalOrder(flow.nodes, links).map((id) => {
    const { node, plugin, config } = byId.get(id)!;
    const p = ports.get(id)!;
    return {
      node,
      plugin,
      config,
      inputPorts: p.inputs,
      outputPorts: p.outputs,
      inputs: links.get(id)!,
    };
  });
}

/**
 * Kahn's algorithm. Among ready nodes the earliest in `flow.nodes` goes first, so the order is
 * deterministic. A cycle is reported at a node that lies on it.
 */
function topologicalOrder(
  nodes: readonly FlowNode[],
  links: ReadonlyMap<string, readonly PortLink[]>,
): string[] {
  const waiting = new Map(nodes.map((n) => [n.id, new Set(links.get(n.id)!.map((l) => l.from))]));
  const order: string[] = [];
  while (waiting.size > 0) {
    let ready: string | undefined;
    for (const [id, deps] of waiting) {
      if (deps.size === 0) {
        ready = id;
        break;
      }
    }
    if (ready === undefined) {
      const node = nodeOnCycle(waiting);
      const label = nodes.find((n) => n.id === node)?.label ?? node;
      fail('executor.error.cycle', { node: label }, node);
    }
    order.push(ready);
    waiting.delete(ready);
    for (const deps of waiting.values()) deps.delete(ready);
  }
  return order;
}

/**
 * Every waiting node still has a waiting predecessor, so walking predecessors from any node revisits
 * one; the first revisited node is on a cycle (a node only downstream of a cycle is never revisited).
 */
function nodeOnCycle(waiting: ReadonlyMap<string, ReadonlySet<string>>): string {
  const seen = new Set<string>();
  let current = waiting.keys().next().value as string;
  while (!seen.has(current)) {
    seen.add(current);
    current = waiting.get(current)!.values().next().value as string;
  }
  return current;
}
