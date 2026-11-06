import { Injectable } from '@nestjs/common';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

@Injectable()
export class DocumentStorageService {
  readonly root = resolve(config.uploadDir);
  async ensureRoot() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  newStorageKey(extension: string) { return `${randomUUID()}${extension}`; }
  pathFor(key: string) {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(key)) throw new Error('INVALID_STORAGE_KEY');
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('INVALID_STORAGE_KEY');
    return path;
  }
  async store(buffer: Buffer, key: string) {
    await this.ensureRoot();
    const handle = await open(this.pathFor(key), 'wx', 0o600);
    try { await handle.writeFile(buffer); } finally { await handle.close(); }
  }
  async cleanup(key?: string | null) {
    if (!key) return;
    try { await unlink(this.pathFor(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
