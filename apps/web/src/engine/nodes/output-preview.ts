import {
  OutputPreviewConfigSchema,
  type FlowDefinition,
  type OutputPreviewConfig,
} from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import { Table } from '../core/table';
import type { ColumnDef, Schema } from '../core/types';
import type { NodePlugin } from './index';

/**
 * `output.preview` (spec §12.1.10): keeps its input (only `columns`, default all) in the engine
 * worker as a result tab, at most `maxRows` rows with a truncated flag. No file, no artifact, no
 * output port. The tab title must differ (ignoring case) from every other preview title and every
 * `output.excel` sheet name. Runs in TypeScript.
 */

const fold = (text: string): string => text.trim().toLowerCase();

/** Titles of the other result tabs of the flow, as written in the (unparsed) node configs. */
function tabNames(flow: FlowDefinition): { previews: string[]; sheets: string[] } {
  const previews: string[] = [];
  const sheets: string[] = [];
  for (const node of flow.nodes) {
    const config = node.config as Record<string, unknown>;
    if (node.type === 'output.preview' && typeof config['title'] === 'string') {
      previews.push(fold(config['title']));
    }
    if (node.type === 'output.excel' && Array.isArray(config['sheets'])) {
      for (const sheet of config['sheets'] as unknown[]) {
        const name = (sheet as Record<string, unknown> | null)?.['name'];
        if (typeof name === 'string') sheets.push(fold(name));
      }
    }
  }
  return { previews, sheets };
}

function shown(config: OutputPreviewConfig, input: Schema): ColumnDef[] {
  if (config.columns === undefined) return [...input];
  const out: ColumnDef[] = [];
  config.columns.forEach((key, i) => {
    const col = input.find((c) => c.key === key);
    if (col === undefined) {
      throw new EngineError(
        'preview.error.unknownColumn',
        { column: key },
        { path: ['columns', i] },
      );
    }
    // A column listed twice is shown once.
    if (!out.some((c) => c.key === key)) out.push(col);
  });
  return out;
}

export const outputPreviewPlugin: NodePlugin<OutputPreviewConfig> = {
  type: 'output.preview',
  configSchema: OutputPreviewConfigSchema,
  ports: { inputs: [{ name: 'in', required: true }], outputs: [] },

  checkConfig(config, flow) {
    const title = fold(config.title);
    const { previews, sheets } = tabNames(flow);
    // This node is one of `previews`.
    const clash = previews.filter((t) => t === title).length > 1 || sheets.includes(title);
    return clash
      ? [
          new EngineError(
            'preview.error.duplicateTitle',
            { title: config.title },
            { path: ['title'] },
          ),
        ]
      : [];
  },

  inferSchema(config, inputs) {
    shown(config, inputs['in'] ?? []);
    return {};
  },

  execute(config, inputs, ctx) {
    if (ctx.emitPreview === undefined) throw new EngineError('executor.error.noRunContext');
    const input = inputs['in']!;
    const columns = shown(config, input.columns);
    const picked = new Table(
      columns,
      columns.map((c) => input.column(c.key)),
      input.rowCount,
    );
    ctx.emitPreview({
      nodeId: ctx.nodeId,
      title: config.title,
      table: picked.slice(0, config.maxRows),
      totalRows: input.rowCount,
      truncated: input.rowCount > config.maxRows,
    });
    return {};
  },
};
