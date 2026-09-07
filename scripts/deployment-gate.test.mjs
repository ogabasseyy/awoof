import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDeployment } from './deployment-gate.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/awoof';
const run = { id: 10, run_attempt: 1, head_sha: sha, head_branch: 'main',
  head_repository: { full_name: repository }, event: 'push', status: 'completed', conclusion: 'success' };
const input = { eventName: 'workflow_dispatch', event: {}, ref: 'refs/heads/main', sha,
  repository, mainSha: sha, runs: [run] };

test('manual deployment requires matching successful push CI', () => {
  assert.equal(validateDeployment(input), sha);
  assert.throws(() => validateDeployment({ ...input, runs: [] }));
  assert.throws(() => validateDeployment({ ...input, ref: 'refs/heads/feature' }));
});
test('an older success cannot conceal a newer failure or pending rerun', () => {
  for (const newer of [{ ...run, id: 11, conclusion: 'failure' },
    { ...run, id: 11, status: 'in_progress', conclusion: null },
    { ...run, run_attempt: 2, conclusion: 'failure' }]) {
    assert.throws(() => validateDeployment({ ...input, runs: [run, newer] }));
  }
});
test('late successful CI cannot deploy an obsolete main revision', () => {
  assert.throws(() => validateDeployment({ ...input, mainSha: 'b'.repeat(40) }));
});
test('workflow completion requires same-repository main push provenance', () => {
  const completion = { ...input, eventName: 'workflow_run', event: { workflow_run: run } };
  assert.equal(validateDeployment(completion), sha);
  for (const altered of [{ ...run, event: 'pull_request' },
    { ...run, head_repository: { full_name: 'untrusted/fork' } },
    { ...run, head_branch: 'feature' }, { ...run, conclusion: 'failure' }]) {
    assert.throws(() => validateDeployment({ ...completion, event: { workflow_run: altered } }));
  }
});
