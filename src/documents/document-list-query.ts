import { BadRequestException } from '@nestjs/common';

export const DOCUMENT_LIST_STATUSES = ['queued', 'processing', 'ready', 'failed', 'cancelled'] as const;
export const DOCUMENT_LIST_TYPES = ['pdf', 'docx', 'xlsx', 'xls', 'csv', 'md', 'txt'] as const;
export type DocumentListQuery = {
  page: number;
  limit: number;
  search: string;
  status?: typeof DOCUMENT_LIST_STATUSES[number];
  fileType?: typeof DOCUMENT_LIST_TYPES[number];
};

export function parseDocumentListQuery(query: Record<string, unknown>): DocumentListQuery {
  if (Object.keys(query).some(key => !['page', 'limit', 'search', 'status', 'fileType'].includes(key))) throw new BadRequestException('INVALID_DOCUMENT_QUERY');
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new BadRequestException('INVALID_PAGINATION');
    return Number(value);
  };
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.trim().length > 200)) throw new BadRequestException('INVALID_DOCUMENT_SEARCH');
  const status = query.status;
  if (status !== undefined && (typeof status !== 'string' || !DOCUMENT_LIST_STATUSES.includes(status as any))) throw new BadRequestException('INVALID_DOCUMENT_STATUS');
  if (query.fileType !== undefined && typeof query.fileType !== 'string') throw new BadRequestException('INVALID_DOCUMENT_FILE_TYPE');
  const fileType = typeof query.fileType === 'string' ? query.fileType.trim().toLowerCase().replace(/^\./, '') : undefined;
  if (fileType !== undefined && !DOCUMENT_LIST_TYPES.includes(fileType as any)) throw new BadRequestException('INVALID_DOCUMENT_FILE_TYPE');
  return { page: integer('page', 1, 1_000_000), limit: integer('limit', 20, 100), search: typeof query.search === 'string' ? query.search.trim() : '', status: status as DocumentListQuery['status'], fileType: fileType as DocumentListQuery['fileType'] };
}
