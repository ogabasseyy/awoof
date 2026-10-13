# Muse Code Review runbook

Advisory PR reviewer. Runs `muse exec` headless on every same-repo pull
request against the default branch and posts the result as a PR review
comment. Never blocks merges, never posts a commit status gate.

## Setup

- Secret `META_API_KEY` (repo Settings -> Secrets and variables -> Actions).
  Without it the workflow skips with a notice. Setting the secret is the
  activation decision: it starts sending PR titles, descriptions, diffs,
  and file context to Meta's API on every eligible PR. Do not set it until
  the credential and data-mode requirements below are met and the
  repository owner has approved activation (recorded in PR #55; this
  runbook records the requirement, not that approval has been granted —
  legal/operational review of the disclosure is outstanding until the
  owner records it).
- Credential: a dedicated Meta Model API key created for this workflow
  only, so it can be revoked without breaking other uses. A
  subscription-linked onboarding key also works, subject to the
  Contributor-mode requirement below. Verify billing in the Meta API
  billing console (subscription vs pay-as-you-go).
- Data mode: with a subscription credential, turn Contributor mode OFF
  first (`/settings` in Muse) and verify it stays off.
  Subscriptions default to Contributor mode, under which Meta may use
  the content sent — prompts, code, files, context, and model
  responses — to train future Meta models, and Meta states that
  sensitive, confidential, or personal information must not be
  submitted in that mode; use the standard (non-Contributor) service
  instead. With a pay-as-you-go API key, verify the selected model is
  not a Contributor-mode variant (on the Model API, Contributor mode
  applies only when calling such a variant). See Meta's Muse
  subscription documentation and Contributor-mode help.
- Optional repo variables: `MUSE_MODEL`, `MUSE_REASONING_EFFORT`
  (default `medium`).

## Key hygiene

The agent holds this key with web tools on. Meta API keys are
team-scoped — no narrower, prompts-only scope exists. Per Meta's API-key
safety guidance, a leaked key can burn the team's rate limits, access
uploaded files, and send requests on the team's behalf; size the
accepted blast radius accordingly:

- Dedicated, revocable key: one key for this workflow only (unique per
  application), never shared with other services or developers.
- Rotation trigger: revoke and rotate immediately if any posted review
  looks tampered with, exfiltrated, or off-mission; treat odd output as
  compromise, and monitor usage for anomalous spikes.
- Spending cap: set plan/prompt limits or spend alerts so one malicious
  same-repo PR cannot silently burn quota.

## Behavior

- Only the latest push per PR is reviewed (concurrency cancel-in-progress);
  manual reruns review their own head and skip when it moved.
- Skips without posting: drafts, closed/merged PRs, forks, stacked or
  custom-base PRs (only the default branch may supply the executed
  workflow revision under `pull_request_target`), title/body-only edits,
  duplicate heads, missing secret.
- Failures that post a short fallback note on the PR (job stays green):
  evidence-collection failures (collect/diff/guidance/prompt phases,
  including a failed head checkout, a phase timeout, or an evidence cap
  — guidance, changed-symlink, or removed-lines evidence), installer
  failures, and agent-run
  failures (quota, errors, invalid output). Two collection-time outages
  are instead silent skips (see below): the PR-metadata lookup and the
  pre-run dedupe lookup.
- Failures that skip silently (workflow logs only, no PR note): stale
  live-state revalidation (head/base moved, mid-run draft or close —
  there is nothing to say), live-state lookup outages (`fresh=false`),
  PR-metadata lookup outages (collect exits `should_review=false`),
  pre-run dedupe-lookup outages (prompt exits `duplicate=true`), and
  trusted-script staging failures (`scripts_ok=false`: missing
  checkout or protocol mismatch). During an outage, check the run logs:
  silence does not mean success.
- Workflow edits take effect after merge (the workflow runs from the
  trusted default-branch revision); script changes are validated pre-merge
  by the secret-free `Muse Review Selftest` workflow.
- Quota safety: bounded prompt, `--max-model-steps` cap, job timeout.
  Subscription prompt limits can never block a merge.

## Files

- `.github/workflows/muse-code-review.yml`: orchestration only.
- `.github/scripts/muse-review/`: all shell programs plus `test.sh`
  (regression suite, run by the selftest workflow).
