#!/usr/bin/env bash
# Revalidate the live PR head before spending a Muse invocation.
#
# A manual rerun uses an isolated concurrency group, so a newer push cannot
# cancel it — without this check the stale run would review (and post about)
# an old head. Runs as its own step so the GitHub token never shares an
# environment with the third-party agent process.
#
# Env in: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, BASE_SHA,
#   GITHUB_OUTPUT.
# Output: fresh=true|false. Always exits 0; fails closed (an unreadable
# lookup is a skip, never a proceed). Both captured commits are checked:
# evidence was collected against that exact base...head pair.
set -euo pipefail

if ! live_shas="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq '[.head.sha, .base.sha] | @tsv' 2>/dev/null)" \
  || [[ -z "${live_shas}" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::warning::Head revalidation lookup failed; skipping run to avoid reviewing a stale head."
  exit 0
fi
live_head="${live_shas%%$'\t'*}"; live_base="${live_shas#*$'\t'}"
if [[ "${live_head}" != "${HEAD_SHA}" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::notice::PR head moved (${HEAD_SHA:0:10} -> ${live_head:0:10}); rerun is stale, skipping Muse invocation."
  exit 0
fi
if [[ "${live_base}" != "${BASE_SHA}" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::notice::PR base moved (${BASE_SHA:0:10} -> ${live_base:0:10}); evidence is stale, skipping Muse invocation."
  exit 0
fi
echo "fresh=true" >> "${GITHUB_OUTPUT}"
