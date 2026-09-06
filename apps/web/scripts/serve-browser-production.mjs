import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nextRoot = join(webRoot, '.next');
const standaloneSource = join(nextRoot, 'standalone');
const staticSource = join(nextRoot, 'static');
const publicSource = join(webRoot, 'public');
const stagePrefix = 'awoof-browser-production-';
const temporaryRoot = realpathSync(tmpdir());
let stageRoot;
let finalized = false;

function requireDirectory(path, label) {
  try {
    if (lstatSync(path).isDirectory()) return;
  } catch {
    // The error below keeps the requested production mode actionable without
    // leaking implementation-specific filesystem failures into test output.
  }
  throw new Error(`Production browser artifact is missing ${label}. Run the approved production build before production browser validation.`);
}

function copyContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function cleanupStage() {
  if (!stageRoot || !existsSync(stageRoot)) {
    stageRoot = undefined;
    return true;
  }

  try {
    const resolvedStageRoot = realpathSync(stageRoot);
    const stageRelativePath = relative(temporaryRoot, resolvedStageRoot);
    if (
      dirname(resolvedStageRoot) !== temporaryRoot
      || !basename(resolvedStageRoot).startsWith(stagePrefix)
      || !stageRelativePath
      || stageRelativePath.startsWith('..')
    ) {
      throw new Error('refusing to remove an unexpected staging path');
    }
    rmSync(resolvedStageRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    stageRoot = undefined;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not remove standalone browser staging artifact: ${message}`);
    return false;
  }
}

function finish(exitCode) {
  if (finalized) return;
  finalized = true;
  const removed = cleanupStage();
  process.exitCode = exitCode === 0 && !removed ? 1 : exitCode;
}

requireDirectory(standaloneSource, '.next/standalone');
requireDirectory(staticSource, '.next/static');
requireDirectory(publicSource, 'public');

if (!existsSync(join(standaloneSource, 'server.js'))) {
  throw new Error('Production browser artifact is missing .next/standalone/server.js. Run the approved production build before production browser validation.');
}

// Next's standalone server changes its working directory to its own output.
// Stage the same public and static siblings that Dockerfile.prod supplies,
// but leave the generated build untouched and keep the temporary stage out of
// the repository.
let server;

try {
  stageRoot = mkdtempSync(join(temporaryRoot, stagePrefix));
  copyContents(standaloneSource, stageRoot);
  cpSync(publicSource, join(stageRoot, 'public'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  mkdirSync(join(stageRoot, '.next'), { recursive: true });
  cpSync(staticSource, join(stageRoot, '.next', 'static'), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  console.log(`Staged standalone browser server at ${stageRoot}`);

  server = spawn(process.execPath, ['server.js'], {
    cwd: stageRoot,
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3108',
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: '3107',
    },
    stdio: 'inherit',
  });
} catch (error) {
  cleanupStage();
  throw error;
}

function stopServer(signal) {
  if (server && !server.killed) {
    server.kill(signal);
    return;
  }
  finish(1);
}

process.once('SIGINT', () => stopServer('SIGINT'));
process.once('SIGTERM', () => stopServer('SIGTERM'));

server.once('error', (error) => {
  console.error(`Unable to start standalone browser server: ${error.message}`);
  finish(1);
});

server.once('close', (code, signal) => {
  finish(code ?? (signal ? 1 : 0));
});
