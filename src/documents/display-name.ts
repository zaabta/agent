import { basename } from 'node:path';

export function repairFilenameEncoding(input: string) {
  // Multer/Busboy defaults multipart header parameters to latin1. A UTF-8
  // filename then arrives as latin1 code points (Arabic D9 86 becomes "Ù").
  // Decode only reversible latin1 byte sequences; preserve valid Unicode and
  // invalid byte sequences unchanged.
  if ([...input].some(character => character.codePointAt(0)! > 0xff)) return input;
  try {
    const bytes = Uint8Array.from([...input], character => character.codePointAt(0)!);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC');
  } catch {
    return input;
  }
}

export function safeDisplayName(input: string) {
  const decoded = repairFilenameEncoding(input);
  const leaf = basename(decoded.replace(/\\/g, '/')).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return leaf.slice(0, 180) || 'upload';
}
