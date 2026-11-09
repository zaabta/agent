import { extname } from 'node:path';
import mammoth from 'mammoth';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { isDrawing, parseDrawing } from './drawing-vision.js';
import { BadRequestException } from '@nestjs/common';

export const SUPPORTED_EXTENSIONS = ['.md', '.txt', '.docx', '.pdf', '.xlsx', '.xls', '.csv', '.png', '.jpg', '.jpeg'] as const;
export interface StructuredCell { sheetName: string; rowNumber: number; address: string; columnName: string; value: string; valueType: string; formula?: string; }
export interface ParsedDocument { extension: string; text: string; structuredCells?: StructuredCell[]; }

function decodeUtf8(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
  catch { throw new BadRequestException('INVALID_UTF8'); }
}

function parseSpreadsheet(buffer: Buffer): { text: string; structuredCells: StructuredCell[] } {
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellDates: true, cellNF: true, cellStyles: false }); }
  catch { throw new BadRequestException('INVALID_SPREADSHEET'); }
  if (!workbook.SheetNames.length) throw new BadRequestException('INVALID_SPREADSHEET');
  const output: string[] = [`Workbook: ${workbook.Props?.Title || 'uploaded workbook'}`];
  const structuredCells: StructuredCell[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    output.push(`\nSheet: ${sheetName}`);
    const ref = sheet['!ref'];
    if (!ref) { output.push('(empty sheet)'); continue; }
    const range = XLSX.utils.decode_range(ref);
    const merges = (sheet['!merges'] || []).map(m => XLSX.utils.encode_range(m));
    if (merges.length) output.push(`Merged cells: ${merges.join(', ')}`);
    for (let row = range.s.r; row <= range.e.r; row++) {
      const cells: string[] = [];
      for (let col = range.s.c; col <= range.e.c; col++) {
        const address = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[address] as XLSX.CellObject | undefined;
        if (!cell || (cell.v == null && !cell.f)) continue;
        const display = cell.w ?? (cell.v == null ? '' : String(cell.v));
        const headerAddress = XLSX.utils.encode_cell({ r: range.s.r, c: col });
        const headerCell = sheet[headerAddress] as XLSX.CellObject | undefined;
        const columnName = headerCell?.w ?? String(headerCell?.v ?? `Column ${col - range.s.c + 1}`);
        cells.push(`${address}=${cell.f ? `formula=${cell.f}; cached=${display}` : display}${row > range.s.r ? ` [${columnName}]` : ''}`);
        structuredCells.push({
          sheetName, rowNumber: row + 1, address,
          columnName,
          value: String(display), valueType: cell.t || typeof cell.v,
          ...(cell.f ? { formula: cell.f } : {}),
        });
      }
      if (cells.length) output.push(`Row ${row + 1}: ${cells.join(' | ')}`);
    }
  }
  if (!structuredCells.length) throw new BadRequestException('EMPTY_DOCUMENT');
  return { text: output.join('\n'), structuredCells };
}

function parseCsvDocument(text: string): { text: string; structuredCells: StructuredCell[] } {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const delimiters = [',', ';', '\t', '|'];
  const delimiter = delimiters.map(value => ({ value, count: sample.split(value).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.value || ',';
  let rows: string[][];
  try { rows = parseCsv(text, { bom: true, delimiter, relax_quotes: false, skip_empty_lines: false, record_delimiter: ['\r\n', '\n', '\r'] }); }
  catch { throw new BadRequestException('MALFORMED_CSV'); }
  if (rows.length < 1) throw new BadRequestException('EMPTY_DOCUMENT');
  const headers = rows[0].map((value, i) => value.trim() || `Column ${i + 1}`);
  const structuredCells: StructuredCell[] = [];
  const lines = [`CSV headers: ${headers.join(' | ')}`, ...rows.slice(1).map((row, index) => {
    row.forEach((value, col) => structuredCells.push({ sheetName: 'CSV', rowNumber: index + 2, address: `${index + 2}:${col + 1}`, columnName: headers[col] || `Column ${col + 1}`, value, valueType: 'string' }));
    const values = headers.map((header, col) => `${header} (column ${col + 1})=${row[col] ?? ''} [cell ${index + 2}:${col + 1}]`);
    return `Row ${index + 2}: ${values.join(' | ')}`;
  })];
  return { text: lines.join('\n'), structuredCells };
}

export async function parseDocument(filename: string, buffer: Buffer, signal?: AbortSignal): Promise<ParsedDocument> {
  const extension = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number])) throw new BadRequestException('UNSUPPORTED_FILE_TYPE');
  if (isDrawing(filename)) return { extension, text: await parseDrawing(filename, buffer, signal) };
  let text: string;
  let structuredCells: StructuredCell[] | undefined;
  if (extension === '.docx') {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new BadRequestException('INVALID_DOCX');
    try {
      const converted = await mammoth.convertToHtml({ buffer });
      text = converted.value
        .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `Heading ${level}: `)
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<tr\b[^>]*>/gi, 'Table row: ')
        .replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_match, cell: string) => `${cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()} | `)
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/(?:p|div|table|ul|ol)>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    }
    catch { throw new BadRequestException('INVALID_DOCX'); }
  } else if (extension === '.pdf') {
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new BadRequestException('INVALID_PDF');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      text = result.pages.map(page => ({ num: page.num, text: page.text.trim() })).filter(page => page.text)
        .map(page => `Page ${page.num}:\n${page.text}`).join('\n\n');
      if (!text.trim()) throw new BadRequestException('OCR_REQUIRED');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('INVALID_PDF');
    } finally { await parser.destroy(); }
  } else if (extension === '.xlsx' || extension === '.xls') {
    if (extension === '.xlsx' && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new BadRequestException('INVALID_SPREADSHEET');
    if (extension === '.xls' && !(buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0)) throw new BadRequestException('INVALID_SPREADSHEET');
    const spreadsheet = parseSpreadsheet(buffer);
    text = spreadsheet.text;
    structuredCells = spreadsheet.structuredCells;
  } else {
    text = decodeUtf8(buffer);
    if (text.includes('\u0000')) throw new BadRequestException('INVALID_TEXT');
    if (extension === '.csv') {
      const csv = parseCsvDocument(text);
      text = csv.text;
      structuredCells = csv.structuredCells;
    } else text = text.split(/\r?\n/).map((line, i) => `Line ${i + 1}: ${line}`).join('\n');
  }
  if (!text.trim()) throw new BadRequestException('EMPTY_DOCUMENT');
  return { extension, text, ...(structuredCells ? { structuredCells } : {}) };
}
