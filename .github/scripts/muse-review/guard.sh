#!/usr/bin/env bash
# Revalidate the live PR head before spending a Muse invocation.
#
# A manual rerun uses an isolated concurrency group, so a newer push cannot
# cancel it — without this check the stale run would review (and post about)
# an old head. Runs as its own step so the GitHub token never shares an
# environment with the third-party agent process. Invoked twice per run —
# pre-install (guard) and pre-invocation (reguard) — to narrow the
# check-to-use window a manual rerun's isolated lane otherwise leaves open.
#
# Env in: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, BASE_SHA,
#   GITHUB_OUTPUT.
# Output: fresh=true|false. Always exits 0; fails closed (an unreadable
# lookup is a skip, never a proceed). Both captured commits are checked:
# evidence was collected against that exact base...head pair. The draft
# flag is checked too: conversion changes neither SHA, so without it a
# mid-run draft transition would still spend a billed invocation. The
# live state is checked as well: a close/merge changes neither SHA nor
# the draft flag, so without it a mid-run close would still spend a
# billed invocation (the closed trigger cancels first-attempt runs, but
# manual reruns sit in isolated lanes the cancel cannot reach).
set -euo pipefail

if ! live_shas="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq '[.head.sha, .base.sha, .draft, .state] | @tsv' 2>/dev/null)" \
  || [[ -z "${live_shas}" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::warning::Head revalidation lookup failed; skipping run to avoid reviewing a stale head."
  exit 0
fi
live_head="${live_shas%%$'\t'*}"; live_rest="${live_shas#*$'\t'}"
live_base="${live_rest%%$'\t'*}"; live_rest="${live_rest#*$'\t'}"
live_draft="${live_rest%%$'\t'*}"; live_state="${live_rest#*$'\t'}"
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
if [[ "${live_draft}" == "true" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::notice::PR was converted to draft; skipping Muse invocation."
  exit 0
fi
if [[ "${live_state}" != "open" ]]; then
  echo "fresh=false" >> "${GITHUB_OUTPUT}"
  echo "::notice::PR is no longer open (state: ${live_state}); skipping Muse invocation."
  exit 0
fi
echo "fresh=true" >> "${GITHUB_OUTPUT}"
