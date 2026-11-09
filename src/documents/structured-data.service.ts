import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';

type CellFilter = { columnName: string; operator: 'EQ' | 'CONTAINS' | 'GT' | 'GTE' | 'LT' | 'LTE'; value: string };
type DatasetFilter = { documentId?: string; sheetName?: string; filters?: CellFilter[]; groupLimit?: number };
export type StructuredSource = { documentId: string; filename: string; sourceRef: string; chunkIndex: number; documentVersionId?: string; chunkId?: string; contentHash?: string };
type QueryRow = Record<string, unknown>;

function joinClauses(clauses: Prisma.Sql[]): Prisma.Sql {
  return clauses.length ? Prisma.join(clauses, ' ') : Prisma.empty;
}

function normalizeSchemaLabel(value: string): string { return value.normalize('NFKD').toLocaleLowerCase('tr-TR').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function rowRanges(values: number[]): string {
  const rows = [...new Set(values)].sort((a, b) => a - b);
  if (!rows.length) return 'no populated data rows';
  const ranges: string[] = [];
  let start = rows[0]!;
  let end = start;
  for (const row of rows.slice(1)) {
    if (row === end + 1) { end = row; continue; }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = end = row;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return `rows ${ranges.join(', ')}`;
}

function source(documentId: string, filename: string, sheetName: string, rows: number[], chunkIndex: number, documentVersionId?: string): StructuredSource {
  return { documentId, ...(documentVersionId ? { documentVersionId } : {}), filename, sourceRef: `${filename} [${documentId.slice(0, 8)}] (${sheetName}, ${rowRanges(rows)})`, chunkIndex };
}

@Injectable()
export class StructuredDataService {
  constructor(@Inject(PrismaService) private readonly prisma: Pick<PrismaService, 'appDocument' | 'appDocumentCell' | '$queryRaw'>) {}

  private async activeVersionIds(tenantId: string, documentId?: string) {
    const documents = await this.prisma.appDocument.findMany({ where: { tenantId, status: 'ready', activeVersionId: { not: null }, ...(documentId ? { id: documentId } : {}) }, select: { activeVersionId: true } });
    return [...new Set(documents.flatMap(document => document.activeVersionId ? [document.activeVersionId] : []))];
  }

  private versionSql(ids: string[], alias = 'c'): Prisma.Sql {
    if (!ids.length) return Prisma.sql`AND FALSE`;
    return Prisma.sql`AND ${Prisma.raw(`${alias}.version_id`)} IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})`;
  }

  private async structuredColumns(tenantId: string, documentId?: string, sheetName?: string): Promise<string[]> {
    const activeVersionIds = await this.activeVersionIds(tenantId, documentId);
    const columns = await this.prisma.appDocumentCell.findMany({
      where: { tenantId, versionId: { in: activeVersionIds }, ...(documentId ? { documentId } : {}), ...(sheetName ? { sheetName } : {}), document: { tenantId, status: 'ready', fileType: { in: ['csv', 'xls', 'xlsx'] } } },
      distinct: ['columnName'], select: { columnName: true }, orderBy: { columnName: 'asc' }, take: 500,
    });
    return columns.map(column => column.columnName);
  }

  private async rowFilterClauses(tenantId: string, filters: CellFilter[] = [], documentId?: string, sheetName?: string): Promise<Prisma.Sql[]> {
    if (filters.length === 0) return [];
    const available = await this.structuredColumns(tenantId, documentId, sheetName);
    return filters.map(filter => {
      const matches = available.filter(column => normalizeSchemaLabel(column) === normalizeSchemaLabel(filter.columnName));
      if (matches.length !== 1) {
        const error = new Error(matches.length ? `FILTER_COLUMN_AMBIGUOUS:${matches.join(',')}` : 'FILTER_COLUMN_NOT_FOUND');
        throw error;
      }
      const column = matches[0]!;
      const numericValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(filter.value.trim());
      const dateValue = /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(filter.value.trim());
      const compare = filter.operator === 'EQ'
        ? Prisma.sql`LOWER(BTRIM(f.value)) = LOWER(BTRIM(${filter.value}))`
        : filter.operator === 'CONTAINS'
          ? Prisma.sql`POSITION(LOWER(${filter.value}) IN LOWER(f.value)) > 0`
          : numericValue
            ? Prisma.sql`CASE WHEN BTRIM(f.value) ~ '^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$' THEN BTRIM(f.value)::numeric END ${filter.operator === 'GT' ? Prisma.sql`>` : filter.operator === 'GTE' ? Prisma.sql`>=` : filter.operator === 'LT' ? Prisma.sql`<` : Prisma.sql`<=`} ${filter.value}::numeric`
            : dateValue
              ? Prisma.sql`BTRIM(f.value) ${filter.operator === 'GT' ? Prisma.sql`>` : filter.operator === 'GTE' ? Prisma.sql`>=` : filter.operator === 'LT' ? Prisma.sql`<` : Prisma.sql`<=`} ${filter.value}`
              : Prisma.sql`LOWER(BTRIM(f.value)) ${filter.operator === 'GT' ? Prisma.sql`>` : filter.operator === 'GTE' ? Prisma.sql`>=` : filter.operator === 'LT' ? Prisma.sql`<` : Prisma.sql`<=`} LOWER(BTRIM(${filter.value}))`;
      return Prisma.sql`AND EXISTS (
        SELECT 1 FROM app_document_cells f
        WHERE f.tenant_id = c.tenant_id AND f.document_id = c.document_id
          AND f.version_id = c.version_id
          AND f.sheet_name = c.sheet_name AND f.row_number = c.row_number
          AND f.column_name = ${column} AND ${compare}
      )`;
    });
  }

  async discoverDatasets(tenantId = config.tenantId, documentId?: string) {
    const activeVersionIds = await this.activeVersionIds(tenantId, documentId);
    const rows = await this.prisma.appDocumentCell.findMany({
      where: {
        tenantId,
        versionId: { in: activeVersionIds },
        ...(documentId ? { documentId } : {}),
        document: { tenantId, status: 'ready', fileType: { in: ['csv', 'xls', 'xlsx'] } },
      },
      distinct: ['documentId', 'sheetName', 'columnName'],
      select: { documentId: true, sheetName: true, columnName: true, document: { select: { filename: true } } },
      orderBy: [{ documentId: 'asc' }, { sheetName: 'asc' }, { columnName: 'asc' }],
      take: 5000,
    });
    const datasets = new Map<string, { documentId: string; filename: string; sheets: Map<string, Set<string>> }>();
    for (const row of rows) {
      let dataset = datasets.get(row.documentId);
      if (!dataset) {
        dataset = { documentId: row.documentId, filename: row.document.filename, sheets: new Map() };
        datasets.set(row.documentId, dataset);
      }
      const columns = dataset.sheets.get(row.sheetName) ?? new Set<string>();
      columns.add(row.columnName);
      dataset.sheets.set(row.sheetName, columns);
    }
    return [...datasets.values()].map(dataset => ({
      documentId: dataset.documentId,
      filename: dataset.filename,
      sheets: [...dataset.sheets.entries()].map(([sheetName, columns]) => ({ sheetName, columns: [...columns] })),
    }));
  }

  async countRecords(tenantId = config.tenantId, filter: DatasetFilter = {}) {
    const startedAt = performance.now();
    const rowFilters = await this.rowFilterClauses(tenantId, filter.filters, filter.documentId, filter.sheetName);
    const documentClause = filter.documentId ? Prisma.sql`AND d.id = ${filter.documentId}::uuid` : Prisma.empty;
    const sheetClause = filter.sheetName ? Prisma.sql`AND c.sheet_name = ${filter.sheetName}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<QueryRow[]>(Prisma.sql`
      SELECT r.document_id AS "documentId", r.version_id AS "versionId", d.filename, r.sheet_name AS "sheetName",
        COUNT(*)::int AS count, MIN(r.row_number)::int AS "firstRow", MAX(r.row_number)::int AS "lastRow"
      FROM (
        SELECT DISTINCT c.document_id, c.version_id, c.tenant_id, c.sheet_name, c.row_number
        FROM app_document_cells c
        JOIN app_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE c.tenant_id = ${tenantId} AND c.version_id = d.active_version_id AND d.status = 'ready' AND d.file_type IN ('csv','xls','xlsx')
          ${documentClause} ${sheetClause} ${joinClauses(rowFilters)}
          AND c.row_number > (
            SELECT MIN(h.row_number) FROM app_document_cells h
            WHERE h.tenant_id = c.tenant_id AND h.document_id = c.document_id AND h.version_id = c.version_id AND h.sheet_name = c.sheet_name
          )
          AND EXISTS (
            SELECT 1 FROM app_document_cells populated
            WHERE populated.tenant_id = c.tenant_id AND populated.document_id = c.document_id AND populated.version_id = c.version_id
              AND populated.sheet_name = c.sheet_name AND populated.row_number = c.row_number
              AND BTRIM(populated.value) <> ''
          )
      ) r
      JOIN app_documents d ON d.id = r.document_id AND d.tenant_id = r.tenant_id
      GROUP BY r.document_id, r.version_id, d.filename, r.sheet_name
      ORDER BY d.filename, r.sheet_name
    `);
    const datasets = rows.map(row => ({
      documentId: String(row.documentId), documentVersionId: String(row.versionId), filename: String(row.filename), sheetName: String(row.sheetName),
      count: Number(row.count), firstRow: Number(row.firstRow), lastRow: Number(row.lastRow),
    }));
    const total = datasets.reduce((sum, dataset) => sum + dataset.count, 0);
    const sources = datasets.map((dataset, index) => source(
      dataset.documentId, dataset.filename, dataset.sheetName,
      dataset.firstRow <= dataset.lastRow ? [dataset.firstRow, dataset.lastRow] : [], index, dataset.documentVersionId,
    ));
    return {
      operation: 'COUNT', total, definition: 'A record is one distinct source row containing at least one nonblank cell. The first used row in each sheet is treated as the header and excluded.',
      datasets, sources, durationMs: Math.round(performance.now() - startedAt),
    };
  }

  async lookupRows(filters: CellFilter[], tenantId = config.tenantId, filter: Omit<DatasetFilter, 'filters'> = {}, limit = 10) {
    if (!filters.length) throw new Error('ROW_LOOKUP_REQUIRES_FILTER');
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const clauses = await this.rowFilterClauses(tenantId, filters, filter.documentId, filter.sheetName);
    const documentClause = filter.documentId ? Prisma.sql`AND d.id = ${filter.documentId}::uuid` : Prisma.empty;
    const sheetClause = filter.sheetName ? Prisma.sql`AND c.sheet_name = ${filter.sheetName}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<QueryRow[]>(Prisma.sql`
      SELECT c.document_id AS "documentId", c.version_id AS "versionId", d.filename, c.sheet_name AS "sheetName", c.row_number AS "rowNumber"
      FROM app_document_cells c JOIN app_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${tenantId} AND c.version_id = d.active_version_id AND d.status = 'ready' AND d.file_type IN ('csv','xls','xlsx')
        ${documentClause} ${sheetClause} ${joinClauses(clauses)}
        AND (d.file_type = 'csv' OR c.row_number > (SELECT MIN(h.row_number) FROM app_document_cells h WHERE h.tenant_id = c.tenant_id AND h.document_id = c.document_id AND h.version_id = c.version_id AND h.sheet_name = c.sheet_name))
      GROUP BY c.document_id, d.filename, c.sheet_name, c.row_number
      ORDER BY d.filename, c.sheet_name, c.row_number LIMIT ${safeLimit}
    `);
    const records = [];
    const sources: StructuredSource[] = [];
    for (const row of rows) {
      const documentId = String(row.documentId);
      const sheetName = String(row.sheetName);
      const rowNumber = Number(row.rowNumber);
      const cells = await this.prisma.appDocumentCell.findMany({
        where: { tenantId, documentId, versionId: String(row.versionId ?? ''), sheetName, rowNumber },
        orderBy: { address: 'asc' }, select: { address: true, columnName: true, value: true },
      });
      const versionId = String(row.versionId);
      const ref = source(documentId, String(row.filename), sheetName, [rowNumber], sources.length, versionId);
      sources.push(ref);
      records.push({ documentId, filename: String(row.filename), sheetName, rowNumber, cells, source: ref });
    }
    return { records, sources };
  }

  async aggregate(
    operation: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'GROUP_BY' | 'DISTINCT',
    columnName: string | undefined,
    tenantId = config.tenantId,
    filter: DatasetFilter = {},
  ) {
    if (operation === 'COUNT') return this.countRecords(tenantId, filter);
    const startedAt = performance.now();
    const rowFilters = await this.rowFilterClauses(tenantId, filter.filters, filter.documentId, filter.sheetName);
    const columns = await this.structuredColumns(tenantId, filter.documentId, filter.sheetName);
    const matches = columns.filter(column => normalizeSchemaLabel(column) === normalizeSchemaLabel(columnName || ''));
    if (!columnName || matches.length !== 1) return { operation, columnName: null, candidates: matches.length ? matches : columns, value: null, groups: [], sources: [], durationMs: Math.round(performance.now() - startedAt) };
    const safeColumn = matches[0]!;
    const documentClause = filter.documentId ? Prisma.sql`AND d.id = ${filter.documentId}::uuid` : Prisma.empty;
    const sheetClause = filter.sheetName ? Prisma.sql`AND c.sheet_name = ${filter.sheetName}` : Prisma.empty;
    const numberPattern = '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$';

    if (operation === 'GROUP_BY' || operation === 'DISTINCT') {
      const limit = filter.groupLimit ?? (operation === 'DISTINCT' ? 100 : 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid group limit');
      const rows = await this.prisma.$queryRaw<QueryRow[]>(Prisma.sql`
        WITH groups AS (
        SELECT c.document_id AS "documentId", c.version_id AS "versionId", d.filename, c.sheet_name AS "sheetName",
          LOWER(BTRIM(c.value)) AS normalized, MIN(BTRIM(c.value)) AS label,
          COUNT(DISTINCT c.row_number)::int AS count,
          ARRAY_AGG(DISTINCT c.row_number ORDER BY c.row_number) AS "rowNumbers"
        FROM app_document_cells c
        JOIN app_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE c.tenant_id = ${tenantId} AND c.version_id = d.active_version_id AND d.status = 'ready' AND d.file_type IN ('csv','xls','xlsx')
          ${documentClause} ${sheetClause} ${joinClauses(rowFilters)} AND c.column_name = ${safeColumn} AND BTRIM(c.value) <> ''
          AND (d.file_type = 'csv' OR c.row_number > (SELECT MIN(h.row_number) FROM app_document_cells h WHERE h.tenant_id = c.tenant_id AND h.document_id = c.document_id AND h.version_id = c.version_id AND h.sheet_name = c.sheet_name))
        GROUP BY c.document_id, c.version_id, d.filename, c.sheet_name, LOWER(BTRIM(c.value))
        ), ranked AS (
          SELECT normalized, SUM(count) AS total
          FROM groups GROUP BY normalized
          ORDER BY total DESC, normalized ASC LIMIT ${limit}
        )
        SELECT groups.* FROM groups JOIN ranked USING (normalized)
        ORDER BY ranked.total DESC, normalized ASC, filename ASC, "sheetName" ASC, "documentId" ASC
      `);
      const groups = new Map<string, { value: string; count: number; sources: StructuredSource[] }>();
      const allSources: StructuredSource[] = [];
      for (const row of rows) {
        const key = String(row.normalized);
        const group = groups.get(key) ?? { value: String(row.label), count: 0, sources: [] };
        group.count += Number(row.count);
        const rowNumbers = Array.isArray(row.rowNumbers) ? row.rowNumbers.map(Number) : [];
        const ref = source(String(row.documentId), String(row.filename), String(row.sheetName), rowNumbers, allSources.length, String(row.versionId));
        group.sources.push(ref); allSources.push(ref); groups.set(key, group);
      }
      const values = [...groups.values()];
      return {
        operation, columnName: safeColumn,
        value: operation === 'DISTINCT' ? values.map(group => group.value) : undefined,
        groups: values, sources: allSources,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

    const numericOperation = operation === 'SUM' ? Prisma.sql`SUM(CASE WHEN BTRIM(c.value) ~ ${numberPattern} THEN BTRIM(c.value)::numeric END)`
      : operation === 'AVG' ? Prisma.sql`AVG(CASE WHEN BTRIM(c.value) ~ ${numberPattern} THEN BTRIM(c.value)::numeric END)`
      : operation === 'MIN' ? Prisma.sql`MIN(CASE WHEN BTRIM(c.value) ~ ${numberPattern} THEN BTRIM(c.value)::numeric END)`
      : Prisma.sql`MAX(CASE WHEN BTRIM(c.value) ~ ${numberPattern} THEN BTRIM(c.value)::numeric END)`;
    const numeric = await this.prisma.$queryRaw<QueryRow[]>(Prisma.sql`
      SELECT ${numericOperation}::text AS value,
        COUNT(*) FILTER (WHERE BTRIM(c.value) ~ ${numberPattern})::int AS "numericCount",
        COUNT(*) FILTER (WHERE BTRIM(c.value) <> '' AND BTRIM(c.value) !~ ${numberPattern})::int AS "nonnumericCount"
      FROM app_document_cells c JOIN app_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${tenantId} AND c.version_id = d.active_version_id AND d.status = 'ready' AND d.file_type IN ('csv','xls','xlsx')
        ${documentClause} ${sheetClause} ${joinClauses(rowFilters)} AND c.column_name = ${safeColumn}
        AND BTRIM(c.value) <> ''
        AND (d.file_type = 'csv' OR c.row_number > (SELECT MIN(h.row_number) FROM app_document_cells h WHERE h.tenant_id = c.tenant_id AND h.document_id = c.document_id AND h.version_id = c.version_id AND h.sheet_name = c.sheet_name))
    `);
    const value = numeric[0]?.value ?? null;
    const provenanceRows = await this.prisma.$queryRaw<QueryRow[]>(Prisma.sql`
      SELECT c.document_id AS "documentId", c.version_id AS "versionId", d.filename, c.sheet_name AS "sheetName",
        ARRAY_AGG(DISTINCT c.row_number ORDER BY c.row_number) FILTER (WHERE BTRIM(c.value) ~ ${numberPattern}) AS "rowNumbers"
      FROM app_document_cells c JOIN app_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${tenantId} AND c.version_id = d.active_version_id AND d.status = 'ready' AND d.file_type IN ('csv','xls','xlsx')
        ${documentClause} ${sheetClause} ${joinClauses(rowFilters)} AND c.column_name = ${safeColumn}
        AND (d.file_type = 'csv' OR c.row_number > (SELECT MIN(h.row_number) FROM app_document_cells h WHERE h.tenant_id = c.tenant_id AND h.document_id = c.document_id AND h.version_id = c.version_id AND h.sheet_name = c.sheet_name))
      GROUP BY c.document_id, c.version_id, d.filename, c.sheet_name
    `);
    const sources = provenanceRows.map((row, index) => source(
      String(row.documentId), String(row.filename), String(row.sheetName),
      Array.isArray(row.rowNumbers) ? row.rowNumbers.map(Number) : [], index, String(row.versionId),
    ));
    return {
      operation, columnName: safeColumn, value,
      numericCount: Number(numeric[0]?.numericCount ?? 0), nonnumericCount: Number(numeric[0]?.nonnumericCount ?? 0),
      sources, durationMs: Math.round(performance.now() - startedAt),
    };
  }

  async lookup(value: string, tenantId = config.tenantId) {
    return this.lookupAnyExact([value], tenantId);
  }

  async lookupAnyExact(values: string[], tenantId = config.tenantId) {
    const candidates = [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 40);
    if (!candidates.length) return { query: '', hits: [], durationMs: 0 };
    const startedAt = performance.now();
    const activeVersionIds = await this.activeVersionIds(tenantId);
    const matches = await this.prisma.appDocumentCell.findMany({
      where: {
        tenantId,
        versionId: { in: activeVersionIds },
        OR: candidates.map(value => ({ value: { equals: value, mode: 'insensitive' as const } })),
        document: { status: 'ready', tenantId },
      },
      include: { document: { select: { id: true, filename: true, activeVersionId: true } } },
      orderBy: [{ documentId: 'asc' }, { sheetName: 'asc' }, { rowNumber: 'asc' }],
      take: 5,
    });
    const groups = new Map<string, { match: typeof matches[number]; columns: Set<string> }>();
    for (const match of matches) {
      const key = `${match.documentId}:${match.sheetName}:${match.rowNumber}`;
      const group = groups.get(key) ?? { match, columns: new Set<string>() };
      group.columns.add(match.columnName);
      groups.set(key, group);
    }
    const hits = [];
    for (const [index, [key, group]] of [...groups].entries()) {
      const { match } = group;
      const [, sheetName, rowText] = key.split(':');
      const rowNumber = Number(rowText);
      const cells = await this.prisma.appDocumentCell.findMany({
        where: { documentId: match.documentId, tenantId, versionId: match.versionId, sheetName, rowNumber },
        orderBy: { address: 'asc' },
        select: { address: true, columnName: true, value: true, formula: true },
      });
      const sourceRef = `${match.document.filename} (${sheetName} row ${rowNumber})`;
      const content = `Source reference: [[${sourceRef}]]\n${match.document.filename} — ${sheetName} row ${rowNumber}: ${cells.map(cell => `${cell.columnName}=${cell.value}${cell.formula ? ` (formula ${cell.formula})` : ''}`).join(' | ')}`;
      hits.push({
        content, score: 1, sourceRef,
        citation: { documentId: match.documentId, documentVersionId: match.versionId, filename: match.document.filename, bucketId: 'structured-data', chunkIndex: index, chunkCount: groups.size },
        metadata: { sheetName, rowNumber, matchedCell: match.address, matchedColumn: match.columnName, matchedColumns: [...group.columns] },
      });
    }
    return { query: candidates.length === 1 ? candidates[0]! : '[authorized exact-value candidates]', hits, durationMs: Math.round(performance.now() - startedAt) };
  }
}
