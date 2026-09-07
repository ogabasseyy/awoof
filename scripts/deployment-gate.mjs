import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateDeployment({ eventName, event, ref, sha, repository, mainSha, runs }) {
  let target;
  if (eventName === 'workflow_dispatch' && ref === 'refs/heads/main') {
    target = sha;
  } else if (eventName === 'workflow_run') {
    const run = event.workflow_run;
    if (run?.event !== 'push' || run.head_branch !== 'main'
      || run.head_repository?.full_name !== repository
      || run.conclusion !== 'success') throw new Error('Untrusted or unsuccessful CI trigger');
    target = run.head_sha;
  } else {
    throw new Error('Deployment requires a main-branch dispatch or trusted CI completion');
  }
  if (!/^[a-f0-9]{40}$/.test(target ?? '') || target !== mainSha) {
    throw new Error('Deployment target is no longer current main');
  }
  const latest = runs.filter((run) => run.head_sha === target && run.event === 'push'
    && run.head_branch === 'main' && run.head_repository?.full_name === repository)
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error('Latest push CI for current main must complete successfully');
  }
  return target;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error('GitHub repository and read token are required');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub deployment check failed: HTTP ${response.status}`);
    return response.json();
  };
  const branch = await api('branches/main');
  const params = new URLSearchParams({ event: 'push', branch: 'main', head_sha: branch.commit.sha, per_page: '100' });
  const runs = [];
  for (let page = 1; ; page++) {
    const result = await api(`actions/workflows/ci.yml/runs?${params}&page=${page}`);
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100) break;
  }
  validateDeployment({ eventName: process.env.GITHUB_EVENT_NAME, event,
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, repository,
    mainSha: branch.commit.sha, runs });
  console.log('Current main has a successful matching push CI run.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
