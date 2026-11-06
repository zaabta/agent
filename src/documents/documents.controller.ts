import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
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
