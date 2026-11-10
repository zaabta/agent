import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {} from 'multer';
import type { Express } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiNotFoundResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { Roles } from '../auth/roles.decorator.js';
import { config } from '../config.js';
import { DocumentsService } from './documents.service.js';
import { DocumentStorageService } from './document-storage.service.js';
import { SUPPORTED_EXTENSIONS } from './parser.js';
import { DOCUMENT_LIST_STATUSES, DOCUMENT_LIST_TYPES, parseDocumentListQuery } from './document-list-query.js';

const diskUpload = diskStorage({
  destination: (_request, _file, callback) => {
    mkdir(resolve(config.uploadDir), { recursive: true, mode: 0o700 }).then(() => callback(null, resolve(config.uploadDir)), error => callback(error as Error, resolve(config.uploadDir)));
  },
  filename: (_request, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
});
const acceptedMime = new Set(['text/markdown', 'text/plain', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv', 'image/png', 'image/jpeg']);
const uploadFilter = (_request: unknown, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) => {
  const extension = extname(file.originalname).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number])) return callback(new BadRequestException('UNSUPPORTED_FILE_TYPE'), false);
  if (!acceptedMime.has(file.mimetype.toLowerCase())) return callback(new BadRequestException('MIME_TYPE_MISMATCH'), false);
  callback(null, true);
};

@ApiTags('documents')
@ApiBearerAuth('bearer')
@ApiSecurity('dev-api-key')
@Controller('api/documents')
@UseGuards(ApiAuthGuard)
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(DocumentStorageService) private readonly storage: DocumentStorageService,
  ) {}
  @Get() @ApiOperation({ summary: 'Search and filter the tenant document catalog with numbered pagination', description: 'Returns { documents, meta }. Search matches filenames, not document contents; POST /search remains the TypeGraph content-search API.' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiQuery({ name: 'search', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Case-insensitive literal filename substring' })
  @ApiQuery({ name: 'status', required: false, enum: DOCUMENT_LIST_STATUSES })
  @ApiQuery({ name: 'fileType', required: false, enum: DOCUMENT_LIST_TYPES })
  @ApiResponse({ status: 200, description: 'documents plus meta: page, limit, count, total, totalPages, hasNextPage, hasPreviousPage and applied filters. Ordered newest first, with ID as the tie-breaker.' })
  @ApiResponse({ status: 401, description: 'Valid bearer JWT required; local dev key is optional when explicitly enabled.' })
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: Record<string, unknown>) { return this.documents.list(principal.tenantId, parseDocumentListQuery(query)); }
  @Get(':id') @ApiOperation({ summary: 'Get one tenant document status and current processing state' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiResponse({ status: 200, description: 'Document status, progress, active version, and timestamps. File size is returned as a number.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND or document belongs to another tenant.' })
  get(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.documents.get(id, principal.tenantId); }
  @Get(':id/versions')
  @ApiOperation({ summary: 'List immutable versions of a tenant document' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiResponse({ status: 200, description: 'Returns documentId, activeVersionId, pagination fields, and versions ordered by versionNumber descending. Storage keys are never returned.' })
  @ApiResponse({ status: 400, description: 'INVALID_DOCUMENT_ID or INVALID_PAGINATION.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND or document belongs to another tenant.' })
  listVersions(@Param('id') id: string, @Query('page') pageValue: string, @Query('limit') limitValue: string, @CurrentPrincipal() principal: AuthPrincipal) {
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!validUuid(id)) throw new BadRequestException('INVALID_DOCUMENT_ID');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('INVALID_PAGINATION');
    return this.documents.listVersions(id, principal.tenantId, page, limit);
  }
  @Post(':id/versions') @HttpCode(202) @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a new immutable document version; the current version stays active until indexing succeeds' })
  @ApiParam({ name: 'id', description: 'Document UUID to replace by adding a new version.' })
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, reason: { type: 'string', maxLength: 500 } } } })
  @ApiResponse({ status: 202, description: 'Returns { document, duplicate, version }. The new version is queued and becomes active only after successful indexing.' })
  @ApiResponse({ status: 400, description: 'FILE_REQUIRED, INVALID_REPLACEMENT_REASON, unsupported type, MIME mismatch, or upload size/signature validation failure.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND or document belongs to another tenant.' })
  @UseInterceptors(FileInterceptor('file', { storage: diskUpload, fileFilter: uploadFilter, limits: { fileSize: config.maxBytes, files: 1 } }))
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  async uploadVersion(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body() body: { reason?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id)) throw new BadRequestException('INVALID_DOCUMENT_ID');
    if (!file) throw new BadRequestException('FILE_REQUIRED');
    if (body?.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) throw new BadRequestException('INVALID_REPLACEMENT_REASON');
    try { return await this.documents.upload({ filename: file.filename, originalName: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path }, principal.tenantId, principal.userId, id, typeof body?.reason === 'string' ? body.reason.trim() || undefined : undefined); }
    catch (error) { await this.storage.cleanup(file.filename).catch(() => undefined); throw error; }
  }
  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'Get a tenant document version and whether it is currently active' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiParam({ name: 'versionId', description: 'Document version UUID.' })
  @ApiResponse({ status: 200, description: 'Version metadata, processing/index state, and active boolean. Storage keys are omitted.' })
  @ApiResponse({ status: 400, description: 'INVALID_DOCUMENT_VERSION_ID.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_VERSION_NOT_FOUND or version belongs to another tenant/document.' })
  getVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.getVersion(id, versionId, principal.tenantId);
  }
  @Post(':id/versions/:versionId/restore') @HttpCode(202)
  @ApiOperation({ summary: 'Restore a retrieval-ready document version as active' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiParam({ name: 'versionId', description: 'Version UUID to restore.' })
  @ApiResponse({ status: 202, description: 'Returns { documentId, activeVersionId, versionNumber, status }; status may be queued while index publication completes.' })
  @ApiResponse({ status: 400, description: 'VERSION_NOT_RETRIEVAL_READY or version job conflict.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_VERSION_NOT_FOUND or cross-tenant version.' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  restoreVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.restoreVersion(id, versionId, principal.tenantId, principal.userId);
  }
  @Post(':id/versions/:versionId/reindex') @HttpCode(202)
  @ApiOperation({ summary: 'Reprocess and reindex a stored document version' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiParam({ name: 'versionId', description: 'Version UUID to reindex.' })
  @ApiResponse({ status: 202, description: 'Returns { documentId, versionId, jobId, indexGeneration, status: queued }. Poll GET /api/jobs/{jobId} or subscribe to its events.' })
  @ApiResponse({ status: 400, description: 'VERSION_CONTENT_UNAVAILABLE or VERSION_JOB_ALREADY_ACTIVE.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_VERSION_NOT_FOUND.' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  reindexVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.reindexVersion(id, versionId, principal.tenantId, principal.userId);
  }
  @Post(':id/versions/:versionId/cancel') @HttpCode(202)
  @ApiOperation({ summary: 'Cancel a queued or active version processing job' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiParam({ name: 'versionId', description: 'Version UUID.' })
  @ApiResponse({ status: 202, description: 'Returns { documentId, versionId, status }, where status is cancelled or cancelling.' })
  @ApiResponse({ status: 400, description: 'VERSION_JOB_NOT_ACTIVE.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_VERSION_NOT_FOUND.' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  cancelVersionJob(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.cancelVersionJob(id, versionId, principal.tenantId);
  }
  @Post('search') @HttpCode(200)
  @ApiOperation({ summary: 'Search indexed workspace documents directly with TypeGraph (no Agent generation)' })
  @ApiBody({ schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 8, default: 5 } } } })
  @ApiResponse({ status: 200, description: 'Matching passages with source references and retrieval timing.' })
  @ApiResponse({ status: 400, description: 'QUERY_REQUIRED or INVALID_SEARCH_LIMIT.' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER', 'READ_ONLY')
  search(@Body() body: { query?: unknown; limit?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    if (typeof body?.query !== 'string' || !body.query.trim() || body.query.trim().length > 2000) {
      throw new BadRequestException('QUERY_REQUIRED');
    }
    const limit = body.limit === undefined ? 5 : body.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new BadRequestException('INVALID_SEARCH_LIMIT');
    }
    return this.documents.search(body.query.trim(), principal.tenantId, principal.userId, limit);
  }
  @Post('upload') @HttpCode(202) @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 202, description: 'Accepted for asynchronous indexing; returns a document and job ID.' })
  @ApiResponse({ status: 400, description: 'FILE_REQUIRED, unsupported type, MIME mismatch, empty/oversized file, invalid signature, or tenant document quota reached.' })
  @UseInterceptors(FileInterceptor('file', { storage: diskUpload, fileFilter: uploadFilter, limits: { fileSize: config.maxBytes, files: 1 } }))
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!file) throw new BadRequestException('FILE_REQUIRED');
    try { return await this.documents.upload({ filename: file.filename, originalName: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path }, principal.tenantId, principal.userId); }
    catch (error) { await this.storage.cleanup(file.filename).catch(() => undefined); throw error; }
  }
  @Post('upload-batch') @HttpCode(202) @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @ApiResponse({ status: 202, description: 'Accepted upload jobs.' })
  @ApiResponse({ status: 400, description: 'FILES_REQUIRED or BATCH_LIMIT_EXCEEDED. Per-file rejections are returned in the rejected array.' })
  @UseInterceptors(FilesInterceptor('files', config.maxBatchFiles, { storage: diskUpload, fileFilter: uploadFilter, limits: { fileSize: config.maxBytes, files: config.maxBatchFiles } }))
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  async uploadBatch(@UploadedFiles() files: Express.Multer.File[], @CurrentPrincipal() principal: AuthPrincipal) {
    if (!files?.length) throw new BadRequestException('FILES_REQUIRED');
    return this.documents.uploadBatch(files.map(file => ({ filename: file.filename, originalName: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path })), principal.tenantId, principal.userId);
  }
  @Delete(':id') @ApiOperation({ summary: 'Cancel processing or delete a tenant document and its TypeGraph index' })
  @ApiParam({ name: 'id', description: 'Document UUID.' })
  @ApiResponse({ status: 200, description: 'Deletion or cancellation result for the tenant document.' })
  @ApiResponse({ status: 400, description: 'Invalid document ID or deletion cannot be completed in the current state.' })
  @ApiNotFoundResponse({ description: 'DOCUMENT_NOT_FOUND or document belongs to another tenant.' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  remove(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.documents.remove(id, principal.tenantId); }
}

function validUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
