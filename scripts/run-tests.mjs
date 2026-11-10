import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (!['unit', 'integration'].includes(mode)) {
  process.stderr.write('Usage: node scripts/run-tests.mjs <unit|integration>\n');
  process.exit(2);
}

const testFiles = readdirSync('test')
  .filter(name => name.endsWith('.test.ts'))
  .filter(name => mode === 'integration' ? name.endsWith('.e2e.test.ts') : !name.endsWith('.e2e.test.ts'))
  .sort()
  .map(name => resolve('test', name));

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
