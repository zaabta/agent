import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {} from 'multer';
import type { Express } from 'express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { Roles } from '../auth/roles.decorator.js';
import { config } from '../config.js';
import { DocumentsService } from './documents.service.js';
import { DocumentStorageService } from './document-storage.service.js';
import { SUPPORTED_EXTENSIONS } from './parser.js';

const diskUpload = diskStorage({
  destination: (_request, _file, callback) => {
    mkdir(resolve(config.uploadDir), { recursive: true, mode: 0o700 }).then(() => callback(null, resolve(config.uploadDir)), error => callback(error as Error, resolve(config.uploadDir)));
  },
  filename: (_request, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
});
const acceptedMime = new Set(['text/markdown', 'text/plain', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv']);
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
  @Get() @ApiOperation({ summary: 'List documents and processing status for the authenticated tenant' })
  @ApiResponse({ status: 401, description: 'Valid bearer JWT required; local dev key is optional when explicitly enabled.' })
  list(@CurrentPrincipal() principal: AuthPrincipal) { return this.documents.list(principal.tenantId); }
  @Get(':id') @ApiOperation({ summary: 'Get one tenant document status' })
  get(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.documents.get(id, principal.tenantId); }
  @Get(':id/versions')
  @ApiOperation({ summary: 'List immutable versions of a tenant document' })
  listVersions(@Param('id') id: string, @Query('page') pageValue: string, @Query('limit') limitValue: string, @CurrentPrincipal() principal: AuthPrincipal) {
    const page = pageValue === undefined ? 1 : Number(pageValue);
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!validUuid(id)) throw new BadRequestException('INVALID_DOCUMENT_ID');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('INVALID_PAGINATION');
    return this.documents.listVersions(id, principal.tenantId, page, limit);
  }
  @Post(':id/versions') @HttpCode(202) @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a new immutable document version; the current version stays active until indexing succeeds' })
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, reason: { type: 'string', maxLength: 500 } } } })
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
  getVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.getVersion(id, versionId, principal.tenantId);
  }
  @Post(':id/versions/:versionId/restore') @HttpCode(202)
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  restoreVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.restoreVersion(id, versionId, principal.tenantId, principal.userId);
  }
  @Post(':id/versions/:versionId/reindex') @HttpCode(202)
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  reindexVersion(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.reindexVersion(id, versionId, principal.tenantId, principal.userId);
  }
  @Post(':id/versions/:versionId/cancel') @HttpCode(202)
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  cancelVersionJob(@Param('id') id: string, @Param('versionId') versionId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!validUuid(id) || !validUuid(versionId)) throw new BadRequestException('INVALID_DOCUMENT_VERSION_ID');
    return this.documents.cancelVersionJob(id, versionId, principal.tenantId);
  }
  @Post('search') @HttpCode(200)
  @ApiOperation({ summary: 'Search indexed workspace documents directly with TypeGraph (no Agent generation)' })
  @ApiBody({ schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 8, default: 5 } } } })
  @ApiResponse({ status: 200, description: 'Matching passages with source references and retrieval timing.' })
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
  @UseInterceptors(FilesInterceptor('files', config.maxBatchFiles, { storage: diskUpload, fileFilter: uploadFilter, limits: { fileSize: config.maxBytes, files: config.maxBatchFiles } }))
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  async uploadBatch(@UploadedFiles() files: Express.Multer.File[], @CurrentPrincipal() principal: AuthPrincipal) {
    if (!files?.length) throw new BadRequestException('FILES_REQUIRED');
    return this.documents.uploadBatch(files.map(file => ({ filename: file.filename, originalName: file.originalname, mimetype: file.mimetype, size: file.size, path: file.path })), principal.tenantId, principal.userId);
  }
  @Delete(':id') @ApiOperation({ summary: 'Cancel processing or delete a tenant document and its TypeGraph index' })
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN', 'MEMBER')
  remove(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.documents.remove(id, principal.tenantId); }
}

function validUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
