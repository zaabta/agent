import { createHash } from 'node:crypto';

export const CHUNKER_VERSION = 'smart-1';
export interface SmartChunk {
  id: string;
  index: number;
  content: string;
  contentHash: string;
  sourceType: string;
  pageNumber?: number;
  headingPath?: string[];
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  cellRange?: string;
  paragraphStart?: number;
  paragraphEnd?: number;
}

const MAX_TOKENS = positiveInt(process.env.SITEPILOT_CHUNK_MAX_TOKENS, 480);
const TARGET_TOKENS = Math.min(positiveInt(process.env.SITEPILOT_CHUNK_TARGET_TOKENS, 360), MAX_TOKENS);
const MIN_TOKENS = Math.min(positiveInt(process.env.SITEPILOT_CHUNK_MIN_TOKENS, 80), TARGET_TOKENS);
const OVERLAP_TOKENS = Math.min(positiveInt(process.env.SITEPILOT_CHUNK_OVERLAP_TOKENS, 40), Math.floor(MAX_TOKENS / 4));
const TABLE_TARGET_TOKENS = Math.max(TARGET_TOKENS, MAX_TOKENS - 30);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Conservative, deterministic estimate without a paid tokenizer service. The
// 4-character floor bounds Latin text; Unicode word pieces handle Arabic/Turkish.
export function estimateTokens(text: string): number {
  const pieces = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const wordEstimate = pieces.reduce((total, part) => total + (/[\p{L}\p{N}_]/u.test(part) ? Math.max(1, Math.ceil(part.length / 4)) : 1), 0);
  return Math.max(wordEstimate, Math.ceil(text.length / 4));
}

function splitLong(text: string): string[] {
  const sentences = text.split(/(?<=[.!?؟。])\s+|\n+/u).filter(Boolean);
  const result: string[] = [];
  let current = '';
  for (const sentence of sentences.length ? sentences : [text]) {
    if (estimateTokens(sentence) > MAX_TOKENS) {
      if (current) { result.push(current); current = ''; }
      let part = '';
      for (const word of sentence.split(/\s+/u)) {
        if (estimateTokens(word) > MAX_TOKENS) {
          if (part) { result.push(part); part = ''; }
          let oversized = '';
          for (const character of [...word]) {
            if (oversized && estimateTokens(oversized + character) > MAX_TOKENS) { result.push(oversized); oversized = ''; }
            oversized += character;
          }
          if (oversized) result.push(oversized);
          continue;
        }
        if (part && estimateTokens(`${part} ${word}`) > MAX_TOKENS) { result.push(part); part = ''; }
        part = part ? `${part} ${word}` : word;
      }
      if (part) result.push(part);
    } else if (current && estimateTokens(`${current}\n${sentence}`) > TARGET_TOKENS) {
      result.push(current); current = sentence;
    } else current = current ? `${current}\n${sentence}` : sentence;
  }
  if (current) result.push(current);
  return result;
}

interface Block { text: string; pageNumber?: number; headingPath?: string[]; sheetName?: string; rowStart?: number; rowEnd?: number; cellRange?: string; paragraphStart?: number; paragraphEnd?: number; }

export interface ChunkableCell { sheetName: string; rowNumber: number; address: string; columnName: string; value: string; formula?: string }

function tableValue(cell: ChunkableCell): string {
  const value = cell.value.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
  return cell.formula ? `${value} (formula ${cell.formula})` : value;
}

function compactCellRange(addresses: string[], rowStart: number, rowEnd: number): string | undefined {
  if (!addresses.length) return undefined;
  const excel = addresses.map(address => address.match(/^([A-Z]{1,3})\d+$/));
  if (excel.every(Boolean)) {
    const columnNumber = (label: string) => [...label].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
    const columns = [...new Set(excel.map(match => match![1]!))].map(label => ({ label, number: columnNumber(label) })).sort((a, b) => a.number - b.number);
    const ranges: Array<[typeof columns[number], typeof columns[number]]> = [];
    for (const column of columns) {
      const last = ranges.at(-1);
      if (last && column.number === last[1].number + 1) last[1] = column;
      else ranges.push([column, column]);
    }
    return ranges.map(([start, end]) => `${start.label}${rowStart}:${end.label}${rowEnd}`).join(',');
  }
  const csv = addresses.map(address => address.match(/^(\d+):(\d+)$/));
  if (csv.every(Boolean)) {
    const columns = [...new Set(csv.map(match => Number(match![2])))].sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (const column of columns) {
      const last = ranges.at(-1);
      if (last && column === last[1] + 1) last[1] = column;
      else ranges.push([column, column]);
    }
    const columnRanges = ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(',');
    return `rows ${rowStart}-${rowEnd}; columns ${columnRanges}`;
  }
  return `${addresses[0]}:${addresses.at(-1)}`;
}

function tableBlocksFromCells(cells: ChunkableCell[], sourceType: string, filename: string): Block[] {
  const bySheet = new Map<string, Map<number, ChunkableCell[]>>();
  for (const cell of cells) {
    const rows = bySheet.get(cell.sheetName) || new Map<number, ChunkableCell[]>();
    const row = rows.get(cell.rowNumber) || [];
    row.push(cell);
    rows.set(cell.rowNumber, row);
    bySheet.set(cell.sheetName, rows);
  }
  const blocks: Block[] = [];
  for (const [sheetName, rows] of bySheet) {
    const isSpreadsheet = ['xls', 'xlsx'].includes(sourceType.replace(/^\./, '').toLowerCase());
    let headerRow = Number.POSITIVE_INFINITY;
    for (const row of rows.keys()) headerRow = Math.min(headerRow, row);
    const dataRows = [...rows.entries()].filter(([row]) => !(isSpreadsheet && row === headerRow)).sort(([a], [b]) => a - b);
    const columns = [...new Map(dataRows.flatMap(([, row]) => row).map(cell => [cell.columnName, cell])).values()];
    const addressColumn = (cell: ChunkableCell) => cell.address.match(/^([A-Z]{1,3})\d+$/)?.[1] || cell.address.match(/^\d+:(\d+)$/)?.[1] || cell.address;
    const keyColumns = columns.filter(cell => /\b(id|code|number|reference|account|form|key)\b/i.test(cell.columnName));
    const otherColumns = columns.filter(cell => !keyColumns.includes(cell));
    const columnBands: ChunkableCell[][] = [];
    let band = [...keyColumns];
    const headingPrefix = [sourceType.replace(/^\./, '').toLowerCase() === 'csv' ? '' : `Workbook: ${filename}`, `Sheet: ${sheetName}`].filter(Boolean).join('\n');
    for (const column of otherColumns) {
      const candidate = [...band, column];
      const header = `${headingPrefix}\nColumns: ${candidate.map(cell => `${addressColumn(cell)}=${cell.columnName}`).join(' | ')}`;
      if (band.length && estimateTokens(header) > Math.floor(TARGET_TOKENS * 0.55)) { columnBands.push(band); band = [...keyColumns, column]; }
      else band = candidate;
    }
    if (band.length) columnBands.push(band);
    if (!columnBands.length && columns.length) columnBands.push(columns);

    for (const columnBand of columnBands) {
      const columnNames = new Set(columnBand.map(cell => cell.columnName));
      const heading = `${headingPrefix}\nColumns: ${columnBand.map((cell, index) => `${index + 1}=${cell.columnName}`).join(' | ')}`;
      let pending: Array<{ line: string; row: number; addresses: string[] }> = [];
      const flush = () => {
        if (!pending.length) return;
        const addresses = pending.flatMap(item => item.addresses);
        const rowStart = pending[0]!.row;
        const rowEnd = pending.at(-1)!.row;
        blocks.push({ text: `${heading}\n${pending.map(item => item.line).join('\n')}`, sheetName, rowStart, rowEnd, cellRange: compactCellRange(addresses, rowStart, rowEnd) });
        pending = [];
      };
      for (const [rowNumber, fullRow] of dataRows) {
        const rowCells = fullRow.filter(cell => columnNames.has(cell.columnName)).sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
        if (!rowCells.length) continue;
        const line = `Row ${rowNumber}: ${rowCells.map(tableValue).join(' | ')}`;
        const candidate = [...pending, { line, row: rowNumber, addresses: rowCells.map(cell => cell.address) }];
        if (pending.length && estimateTokens(`${heading}\n${candidate.map(item => item.line).join('\n')}`) > TABLE_TARGET_TOKENS) flush();
        if (estimateTokens(`${heading}\n${line}`) <= MAX_TOKENS) pending.push({ line, row: rowNumber, addresses: rowCells.map(cell => cell.address) });
        else {
          flush();
          let fragment: ChunkableCell[] = [];
          for (const cell of rowCells) {
            const next = [...fragment, cell];
            const fragmentText = `Row ${rowNumber}: ${next.map(tableValue).join(' | ')}`;
            if (fragment.length && estimateTokens(`${heading}\n${fragmentText}`) > TARGET_TOKENS) {
              blocks.push({ text: `${heading}\nRow ${rowNumber}: ${fragment.map(tableValue).join(' | ')}`, sheetName, rowStart: rowNumber, rowEnd: rowNumber, cellRange: compactCellRange(fragment.map(item => item.address), rowNumber, rowNumber) });
              fragment = [];
            }
            fragment.push(cell);
          }
          if (fragment.length) blocks.push({ text: `${heading}\nRow ${rowNumber}: ${fragment.map(tableValue).join(' | ')}`, sheetName, rowStart: rowNumber, rowEnd: rowNumber, cellRange: compactCellRange(fragment.map(item => item.address), rowNumber, rowNumber) });
        }
      }
      flush();
    }
  }
  return blocks;
}

function blocksFor(sourceType: string, text: string): Block[] {
  if (['pdf', 'png', 'jpg', 'jpeg'].includes(sourceType)) {
    return [...text.matchAll(/(?:^|\n)Page\s+(\d+)\s*:\s*([\s\S]*?)(?=\nPage\s+\d+\s*:|$)/gi)]
      .map(m => ({ text: m[2]!.trim(), pageNumber: Number(m[1]) })).filter(b => b.text);
  }
  if (sourceType === 'csv' || sourceType === 'xls' || sourceType === 'xlsx') {
    const lines = text.split(/\r?\n/);
    const sheet: string[] = [];
    let name = sourceType === 'csv' ? 'CSV' : 'Workbook';
    let rows: Block[] = [];
    const groups: Block[] = [];
    const flush = () => {
      if (!rows.length) return;
      const heading = sheet.filter(line => /^(?:Workbook:|Merged cells:)/.test(line)).join('\n');
      const header = lines.find(line => line.startsWith('CSV headers:'));
      for (let i = 0; i < rows.length;) {
        let selected: Block[] = [];
        while (i < rows.length) {
          const candidate = [...selected, rows[i]!];
          if (selected.length && estimateTokens([heading, header && selected.length === 0 ? header : '', ...candidate.map(r => r.text)].join('\n')) > TARGET_TOKENS) break;
          selected = candidate; i++;
          if (estimateTokens(selected.map(r => r.text).join('\n')) >= TARGET_TOKENS) break;
        }
        const body = selected.map(r => r.text).join('\n');
        const hasSeparateCsvHeader = sourceType === 'csv' && header;
        groups.push({ text: [heading, hasSeparateCsvHeader ? header : '', body].filter(Boolean).join('\n'), sheetName: name,
          rowStart: selected[0]?.rowStart, rowEnd: selected.at(-1)?.rowEnd });
      }
      rows = [];
    };
    for (const line of lines) {
      if (/^Sheet:\s*/i.test(line)) { flush(); sheet.length = 0; name = line.slice(line.indexOf(':') + 1).trim(); sheet.push(line); continue; }
      const row = line.match(/^Row\s+(\d+)\s*:\s*(.*)$/i);
      if (row) rows.push({ text: line, rowStart: Number(row[1]), rowEnd: Number(row[1]) });
      else if (/^(?:Workbook:|CSV headers:|Merged cells:)/.test(line)) sheet.push(line);
      else if (line.trim() && rows.length) rows[rows.length - 1]!.text += `\n${line}`;
    }
    flush();
    if (groups.length) return groups;
  }
  if (sourceType === 'md' || sourceType === 'markdown' || sourceType === 'docx') {
    const lines = text.split(/\r?\n/);
    const output: Block[] = [];
    const path: string[] = [];
    let pending: string[] = [];
    let paragraphNumber = 0;
    let fenced = false;
    const flush = () => {
      const value = pending.join('\n').trim();
      if (value) {
        const paragraphs = value.split(/\n\s*\n/u).filter(part => part.trim()).length;
        const paragraphStart = paragraphNumber + 1;
        paragraphNumber += paragraphs;
        output.push({ text: value, headingPath: [...path], ...(sourceType === 'docx' ? { paragraphStart, paragraphEnd: paragraphNumber } : {}) });
      }
      pending = [];
    };
    for (const line of lines) {
      const md = line.match(/^(?:Line\s+\d+:\s*)?\s*(#{1,6})\s+(.+)$/);
      const docx = line.match(/^Heading\s+(\d+):\s*(.*)$/i);
      if (!fenced && (md || docx)) {
        flush();
        const title = (md?.[2] || docx?.[2] || '').trim();
        const level = md ? md[1]!.length : Number(docx?.[1] || 1);
        path.length = Math.min(path.length, level - 1);
        path[level - 1] = title;
        pending.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) fenced = !fenced;
      pending.push(line);
    }
    flush();
    if (output.length) return output;
  }
  return text.split(/\n\s*\n/u).map(text => ({ text: text.trim() })).filter(b => b.text);
}

export function smartChunk(text: string, sourceType: string, identity: { documentId: string; documentVersionId?: string; originalFilename?: string }, structuredCells?: ChunkableCell[]): SmartChunk[] {
  const normalizedType = sourceType.replace(/^\./, '').toLowerCase();
  const blocks = structuredCells?.length && ['csv', 'xls', 'xlsx'].includes(normalizedType)
    ? tableBlocksFromCells(structuredCells, sourceType, identity.originalFilename || 'uploaded workbook')
    : blocksFor(normalizedType, text);
  const output: Omit<SmartChunk, 'id' | 'index' | 'contentHash'>[] = [];
  for (const block of blocks) {
    const segments = splitLong(block.text);
    for (let i = 0; i < segments.length; i++) {
      let content = segments[i]!.trim();
      if (i > 0 && !['csv', 'xls', 'xlsx'].includes(sourceType.replace(/^\./, '').toLowerCase())) {
        const previousWords = segments[i - 1]!.split(/\s+/u);
        let overlap = '';
        for (const word of previousWords.slice(-OVERLAP_TOKENS * 2)) {
          const candidate = overlap ? `${overlap} ${word}` : word;
          if (estimateTokens(candidate) > OVERLAP_TOKENS) overlap = word;
          else overlap = candidate;
        }
        if (overlap) {
          const candidate = `${overlap}\n${content}`;
          if (estimateTokens(candidate) <= MAX_TOKENS) content = candidate;
        }
      }
      if (!content) continue;
      const addresses = [...content.matchAll(/\b([A-Z]{1,3}\d+)\s*=/g)].map(match => match[1]!);
      const csvAddresses = [...content.matchAll(/\b(?:cell\s+)?(\d+):(\d+)\s*=/gi)].map(match => ({ row: Number(match[1]), col: Number(match[2]) }));
      const cellRange = block.cellRange || (addresses.length ? `${addresses[0]}:${addresses.at(-1)}` : csvAddresses.length ? `${csvAddresses[0]!.row}:${Math.min(...csvAddresses.map(cell => cell.col))}-${csvAddresses.at(-1)!.row}:${Math.max(...csvAddresses.map(cell => cell.col))}` : undefined);
      output.push({ content, sourceType: normalizedType, ...(cellRange ? { cellRange } : {}), ...(block.pageNumber ? { pageNumber: block.pageNumber } : {}), ...(block.headingPath?.length ? { headingPath: block.headingPath } : {}), ...(block.sheetName ? { sheetName: block.sheetName } : {}), ...(block.rowStart ? { rowStart: block.rowStart } : {}), ...(block.rowEnd ? { rowEnd: block.rowEnd } : {}), ...(block.paragraphStart ? { paragraphStart: block.paragraphStart } : {}), ...(block.paragraphEnd ? { paragraphEnd: block.paragraphEnd } : {}) });
    }
  }
  const normalized = sourceType.replace(/^\./, '').toLowerCase();
  if (!['csv', 'xls', 'xlsx'].includes(normalized)) {
    for (let index = 0; index < output.length - 1;) {
      const current = output[index]!;
      const next = output[index + 1]!;
      const sameSource = current.pageNumber === next.pageNumber && JSON.stringify(current.headingPath || []) === JSON.stringify(next.headingPath || []);
      if (sameSource && estimateTokens(current.content) < MIN_TOKENS && estimateTokens(`${current.content}\n${next.content}`) <= TARGET_TOKENS) {
        current.content = `${current.content}\n${next.content}`;
        current.paragraphEnd = next.paragraphEnd ?? current.paragraphEnd;
        output.splice(index + 1, 1);
      } else index++;
    }
  }
  const targetId = identity.documentVersionId || identity.documentId;
  return output.map((chunk, index) => {
    const contentHash = createHash('sha256').update(chunk.content).digest('hex');
    const id = createHash('sha256').update(`${targetId}\0${index}\0${contentHash}`).digest('hex').slice(0, 32);
    return { ...chunk, index, contentHash, id };
  });
}

export const smartChunkSettings = { maxTokens: MAX_TOKENS, targetTokens: TARGET_TOKENS, tableTargetTokens: TABLE_TARGET_TOKENS, minTokens: MIN_TOKENS, overlapTokens: OVERLAP_TOKENS };
