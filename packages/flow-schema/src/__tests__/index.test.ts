import { describe, expect, it } from 'vitest';
import * as schema from '../index';

describe('package entry', () => {
  it('re-exports the schemas of every module', () => {
    for (const name of [
      'IdentifierSchema',
      'FlowParamSchema',
      'InputSlotSchema',
      'CompareConfigSchema',
      'OutputExcelConfigSchema',
      'OutputPreviewConfigSchema',
      'FormulaConfigSchema',
      'FlowDefinitionSchema',
      'migrateFlowDefinition',
    ]) {
      expect(schema).toHaveProperty(name);
    }
  });
});
