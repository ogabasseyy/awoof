# Muse Code Review runbook

Advisory PR reviewer. Runs `muse exec` headless on every same-repo pull
request and posts the result as a PR review comment. Never blocks merges,
never posts a commit status gate.

## Setup

- Secret `META_API_KEY` (repo Settings -> Secrets and variables -> Actions).
  Without it the workflow skips with a notice. The key may be a
  subscription-linked key from `muse login` onboarding or a pay-as-you-go
  Meta Model API key; the workflow cannot tell the difference, so verify
  billing in the Meta API billing console.
- Optional repo variables: `MUSE_MODEL`, `MUSE_REASONING_EFFORT`
  (default `medium`).

## Key hygiene

The agent holds this key with web tools on:

- Minimum scope: a key that can only run model prompts, nothing else.
- Rotation trigger: rotate immediately if any posted review looks tampered
  with, exfiltrated, or off-mission; treat odd output as compromise.
- Spending cap: set plan/prompt limits or spend alerts so one malicious
  same-repo PR cannot silently burn quota.

## Behavior

- Only the latest push per PR is reviewed (concurrency cancel-in-progress);
  manual reruns review their own head and skip when it moved.
- Skips without posting: drafts, closed/merged PRs, forks, title/body-only
  edits, duplicate heads, missing secret.
- Every failure degrades to a short fallback note on the PR; the job stays
  green. Workflow edits take effect after merge (the workflow runs from the
  trusted base revision); script changes are validated pre-merge by the
  secret-free `Muse Review Selftest` workflow.
- Quota safety: bounded prompt, `--max-model-steps` cap, job timeout.
  Subscription prompt limits can never block a merge.

## Files

- `.github/workflows/muse-code-review.yml`: orchestration only.
- `.github/scripts/muse-review/`: all shell programs plus `test.sh`
  (regression suite, run by the selftest workflow).
