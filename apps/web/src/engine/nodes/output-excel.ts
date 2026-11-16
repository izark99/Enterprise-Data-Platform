import { OutputExcelConfigSchema, type OutputExcelConfig } from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import { perfMeasure, perfStart } from '../core/perf';
import type { PortDef } from '../core/types';
import { writeWorkbook } from '../io/excel-writer';
import type { NodePlugin, ParamValue } from './index';

/**
 * `output.excel` (spec §11, §12.1.9): one sheet per configured input port, written as one `.xlsx`
 * (bold header, frozen first row, auto-filter, widths, number formats: `io/excel-writer.ts`) and
 * handed to the run as a file. The node has no output port.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sheetPorts(config: OutputExcelConfig): PortDef[] {
  return [...new Set(config.sheets.map((s) => s.port))].map((name) => ({ name, required: true }));
}

/**
 * The file name with `{param_key}` replaced by the run parameter (month / date parameters arrive as
 * `YYYY-MM` / `YYYY-MM-DD`, 03 §4.5); an unknown placeholder becomes empty. Characters no OS allows
 * in a name become `_`; the name always ends with `.xlsx`.
 */
export function resolveFileName(
  template: string,
  params: Readonly<Record<string, ParamValue>>,
): string {
  const filled = template.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, key: string) => {
    const value = params[key];
    return value === null || value === undefined ? '' : String(value);
  });
  // eslint-disable-next-line no-control-regex
  const safe = filled.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'output';
  return /\.xlsx$/i.test(safe) ? safe : `${safe}.xlsx`;
}

export const outputExcelPlugin: NodePlugin<OutputExcelConfig> = {
  type: 'output.excel',
  configSchema: OutputExcelConfigSchema,
  ports: { inputs: [], outputs: [] },
  inputPorts: sheetPorts,

  inferSchema() {
    return {};
  },

  async execute(config, inputs, ctx) {
    const run = ctx.run;
    if (run === undefined) throw new EngineError('executor.error.noRunContext');
    const sheets = config.sheets.map((sheet) => {
      const table = inputs[sheet.port];
      if (table === undefined) {
        throw new EngineError('executor.error.missingInput', {
          node: ctx.flow.nodes.find((n) => n.id === ctx.nodeId)?.label ?? ctx.nodeId,
          port: sheet.port,
        });
      }
      return { name: sheet.name, table };
    });
    const started = perfStart();
    const bytes = await writeWorkbook(sheets);
    perfMeasure('write', started);
    run.emitFile({
      fileName: resolveFileName(config.fileName, run.params),
      mimeType: XLSX_MIME,
      bytes,
    });
    return {};
  },
};
