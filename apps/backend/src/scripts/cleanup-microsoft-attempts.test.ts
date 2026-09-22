import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('cleanup CLI masks bootstrap connection values and emits one fixed failure', async () => {
    const script = fileURLToPath(new URL('../../scripts/cleanup-microsoft-attempts.ts', import.meta.url));
    const canary = 'CLI_CONNECTION_CANARY_MUST_NOT_LEAK';
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            env: { ...process.env, DATABASE_URL: `postgresql://user:${canary}@127.0.0.1:1/awoof`, DB_HOST: '', DB_NAME: '', DB_USER: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = ''; let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value; });
        child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(outcome.code, 1);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, 'microsoft retention cleanup failed\n');
    assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(canary), false);
});
