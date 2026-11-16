import {
  InputExcelConfigSchema,
  type FlowDefinition,
  type InputExcelConfig,
  type InputSlot,
} from '@hrflow/flow-schema';
import { EngineError } from '../core/errors';
import type { ColumnDef } from '../core/types';
import { SOURCE_FILE_COLUMN, columnTitle } from '../io/validation';
import type { NodePlugin } from './index';

/**
 * `input.excel` (spec §12.1.9): the table of one input slot. The slot files are read and checked
 * before the run (spec §10); the node takes that result from the run context instead of reading
 * the files a second time, and refuses to run on a slot whose report has errors.
 */

/** Output port of `input.excel` (spec §12.1 "Quy ước chung"). */
export const INPUT_EXCEL_PORT = 'table';

function findSlot(config: InputExcelConfig, flow: FlowDefinition): InputSlot {
  const slot = flow.inputSlots.find((s) => s.key === config.slot);
  if (slot === undefined) {
    throw new EngineError('executor.error.unknownSlot', { slot: config.slot }, { path: ['slot'] });
  }
  return slot;
}

export const inputExcelPlugin: NodePlugin<InputExcelConfig> = {
  type: 'input.excel',
  configSchema: InputExcelConfigSchema,
  ports: { inputs: [], outputs: [{ name: INPUT_EXCEL_PORT, required: false }] },

  checkConfig(config, flow) {
    return flow.inputSlots.some((s) => s.key === config.slot)
      ? []
      : [new EngineError('executor.error.unknownSlot', { slot: config.slot }, { path: ['slot'] })];
  },

  // Extra columns of `extraColumns: 'keep'` are unknown at design time: only `code.sql` sees them,
  // at run time (spec §12.1.9).
  warnings(config, flow) {
    const slot = flow.inputSlots.find((s) => s.key === config.slot);
    return slot?.extraColumns === 'keep'
      ? [{ messageKey: 'inputExcel.warning.extraColumnsRuntimeOnly', params: { slot: slot.label } }]
      : [];
  },

  inferSchema(config, _inputs, ctx) {
    const slot = findSlot(config, ctx.flow);
    const columns: ColumnDef[] = slot.columns.map((col) => ({
      key: col.key,
      title: columnTitle(col),
      type: col.type,
    }));
    if (slot.multiple.enabled) {
      columns.push({ key: SOURCE_FILE_COLUMN, title: SOURCE_FILE_COLUMN, type: 'string' });
    }
    return { [INPUT_EXCEL_PORT]: columns };
  },

  execute(config, _inputs, ctx) {
    if (ctx.run === undefined) throw new EngineError('executor.error.noRunContext');
    const slot = findSlot(config, ctx.flow);
    const result = ctx.run.slots[slot.key];
    if (result === undefined)
      throw new EngineError('validation.slotRequired', { slot: slot.label });
    if (result.report.errorCount > 0) {
      throw new EngineError('executor.error.inputInvalid', {
        slot: slot.label,
        count: result.report.errorCount,
      });
    }
    return { [INPUT_EXCEL_PORT]: result.table };
  },
};
