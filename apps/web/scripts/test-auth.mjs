import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(webRoot, '.auth-test-'));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: webRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

try {
  if (run([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.auth-tests.json', '--outDir', output])) {
    const directory = join(output, 'tests', 'auth');
    const files = readdirSync(directory).filter((name) => name.endsWith('.test.js'));
    if (files.length === 0) throw new Error('No compiled auth tests found');
    run(['--test', ...files.map((name) => join(directory, name))]);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
