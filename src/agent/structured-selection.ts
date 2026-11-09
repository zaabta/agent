import { z } from 'zod';

export const cellFilterSchema = z.object({
  columnName: z.string().min(1).max(250),
  operator: z.enum(['EQ', 'CONTAINS', 'GT', 'GTE', 'LT', 'LTE']),
  value: z.string().max(1000),
});

export const structuredSelectionSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  sheetName: z.string().min(1).max(250),
  columnName: z.string().min(1).max(250),
  values: z.array(z.string().min(1).max(250)).min(1).max(20),
  filters: z.array(cellFilterSchema).max(8),
});

export type StructuredSelection = z.infer<typeof structuredSelectionSchema>;
