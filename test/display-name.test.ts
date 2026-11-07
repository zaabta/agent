import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairFilenameEncoding, safeDisplayName } from '../src/documents/display-name.js';

test('Arabic and Turkish filenames survive valid Unicode round trips unchanged', () => {
  for (const filename of ['ملف-علي.pdf', 'İşletme-Çözüm.docx', 'ıslak-imza.csv']) {
    assert.equal(repairFilenameEncoding(filename), filename);
    assert.equal(safeDisplayName(filename), filename);
  }
});

test('reversible multipart latin1 mojibake is repaired without changing unrelated names', () => {
  const arabic = 'ملف-علي.pdf';
  const mojibake = Buffer.from(arabic, 'utf8').toString('latin1');
  assert.equal(repairFilenameEncoding(mojibake), arabic);
  assert.equal(safeDisplayName(mojibake), arabic);
  assert.equal(repairFilenameEncoding('resume.pdf'), 'resume.pdf');
});
