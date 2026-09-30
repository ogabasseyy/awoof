#!/usr/bin/env bash
# Collect PR metadata, changed-file evidence, and the path manifest.
#
# Env in: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA_EVENT,
#   GITHUB_OUTPUT, RUNNER_TEMP, SCRIPT_DIR.
# Files out: muse-pr.json, muse-files.json, muse-manifest.txt, muse-vars.env.
# Outputs: head_sha, base_ref, base_sha, should_review.
#
# Stale/closed/unreadable PRs set MUSE_STOP=1 in muse-vars.env and exit 0 so
# later phases in the step exit quietly without running.
set -euo pipefail

# shellcheck disable=SC1091  # SCRIPT_DIR is set by the workflow step
. "${SCRIPT_DIR}/lib.sh"

pr_file="${RUNNER_TEMP}/muse-pr.json"
if ! gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" > "${pr_file}" 2>/dev/null; then
  echo "should_review=false" >> "${GITHUB_OUTPUT}"
  echo "MUSE_STOP=1" > "${RUNNER_TEMP}/muse-vars.env"
  echo "::warning::Could not fetch PR metadata; skipping (retry on next event)."
  exit 0
fi

# Use the event SHA everywhere so checkout, diff, commit_id, and the review
# marker always agree. If the PR moved since this run started (re-run of an
# older run), skip: a newer run owns the new head.
api_head_sha="$(jq -r '.head.sha' "${pr_file}")"
if [[ "${api_head_sha}" != "${HEAD_SHA_EVENT}" ]]; then
  echo "should_review=false" >> "${GITHUB_OUTPUT}"
  echo "MUSE_STOP=1" > "${RUNNER_TEMP}/muse-vars.env"
  echo "::notice::PR head moved (${HEAD_SHA_EVENT} -> ${api_head_sha}); skipping stale run."
  exit 0
fi
head_sha="${HEAD_SHA_EVENT}"
base_ref="$(jq -r '.base.ref' "${pr_file}")"
base_sha_full="$(jq -r '.base.sha' "${pr_file}")"
base_sha="${base_sha_full}"
echo "base_sha=${base_sha_full}" >> "${GITHUB_OUTPUT}"
# Default branch decides guidance trust (see trust_base in lib.sh): a PR base
# is contributor-controlled unless it is the default branch. Prefer the repo
# object embedded in the PR payload; fall back to one metadata call. Empty on
# failure fails closed (all guidance UNTRUSTED, still reviewed).
default_branch="$(jq -r '.base.repo.default_branch // ""' "${pr_file}")"
if [[ -z "${default_branch}" ]]; then
  default_branch="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '.default_branch' 2>/dev/null || true)"
fi

# Best-effort base fetch up front: the file list, diff ranges, and trusted
# guidance all derive from it. Fetches the captured base SHA (not the live
# branch ref, which could advance mid-run). Works anonymously on public
# repos; on failure the compare API backs the file list and head guidance
# is labeled UNTRUSTED.
base_available=false
if git fetch --depth 1 origin "${base_sha_full}" >/dev/null 2>&1; then
  base_available=true
fi
# Merge-base discovery: two-dot diff would include base-only changes made
# after divergence, while the reviewed API diff uses three-dot semantics.
# Deepen until the merge base resolves. A failure here only disables the
# LOCAL file list (compare API backs it); the fetched base tip still backs
# trusted guidance.
local_diff=false
merge_base=""
if [[ "${base_available}" == "true" ]]; then
  for _ in 1 2 3 4 5; do
    if merge_base="$(git merge-base "${base_sha_full}" "${head_sha}" 2>/dev/null)"; then
      local_diff=true
      break
    fi
    git fetch --deepen 100 origin "${base_sha_full}" "${head_sha}" >/dev/null 2>&1 || break
  done
  if [[ "${local_diff}" != "true" ]]; then
    echo "::warning::merge-base not found; file list falls back to compare API."
  fi
fi
head_ref="$(jq -r '.head.ref' "${pr_file}")"
pr_state="$(jq -r '.state' "${pr_file}")"
pr_title="$(jq -r '.title' "${pr_file}")"
pr_body="$(jq -r '.body // ""' "${pr_file}")"
# Byte-bound the UNTRUSTED submitter text: without a cap a huge PR
# description blows the prompt budget and can starve the diff of quota or
# get the request rejected outright.
pr_title="$(bound_untrusted "${pr_title}" 2000)"
pr_body="$(bound_untrusted "${pr_body}" 12000)"

echo "head_sha=${head_sha}" >> "${GITHUB_OUTPUT}"
echo "base_ref=${base_ref}" >> "${GITHUB_OUTPUT}"

if [[ "${pr_state}" != "open" ]]; then
  echo "should_review=false" >> "${GITHUB_OUTPUT}"
  echo "MUSE_STOP=1" > "${RUNNER_TEMP}/muse-vars.env"
  echo "::notice::Pull request #${PR_NUMBER} is not open; skipping Muse review."
  exit 0
fi
echo "should_review=true" >> "${GITHUB_OUTPUT}"

# Immutable evidence pinned to the event SHA: the compare API reads
# base...head as fixed commits, so a mid-run push cannot mix files or diff
# hunks from two commits.
files_file="${RUNNER_TEMP}/muse-files.json"
# Complete path list from local git (no 300-file cap), diffed from the merge
# base so base-only changes are excluded — the same three-dot semantics as
# the reviewed API diff. The compare API is the fallback when local history
# is unavailable (e.g. private repos, where anonymous fetch has no creds).
files_source="local"
if [[ "${local_diff}" == "true" ]]; then
  ns_file="${RUNNER_TEMP}/muse-namestat.txt"
  num_file="${RUNNER_TEMP}/muse-numstat.txt"
  if git -c core.quotePath=false diff -z --name-status "${merge_base}" "${head_sha}" > "${ns_file}" 2>/dev/null \
    && git -c core.quotePath=false diff -z --numstat "${merge_base}" "${head_sha}" > "${num_file}" 2>/dev/null; then
    # NUL-delimited parse: tab/newline paths stay intact (both streams share
    # record order, so read them in lockstep).
    : > "${files_file}.jsonl"
    exec 3<"${ns_file}" 4<"${num_file}"
    join_ok=true
    while IFS= read -r -d '' st <&3; do
      IFS= read -r -d '' p1 <&3 || { join_ok=false; break; }
      prev=""
      if [[ "${st}" == [RC]* ]]; then
        IFS= read -r -d '' p2 <&3 || { join_ok=false; break; }
        path="${p2}"
        prev="${p1}"
      else
        path="${p1}"
      fi
      IFS= read -r -d '' numrec <&4 || { join_ok=false; break; }
      # numstat -z emits rename/copy preimage/postimage as two extra NUL
      # records after the counts; consume them to stay aligned. Copies
      # only occur with --find-copies (currently off — latent hardening).
      if [[ "${st}" == [RC]* ]]; then
        IFS= read -r -d '' _ns_old <&4 || { join_ok=false; break; }
        IFS= read -r -d '' _ns_new <&4 || { join_ok=false; break; }
      fi
      add="${numrec%%$'\t'*}"; rest="${numrec#*$'\t'}"; del="${rest%%$'\t'*}"
      if ! [[ "${add}" =~ ^[0-9]+$ ]]; then add=0; fi
      if ! [[ "${del}" =~ ^[0-9]+$ ]]; then del=0; fi
      case "${st}" in
        A*) s="added";; D*) s="removed";; R*) s="renamed";; C*) s="copied";; *) s="modified";;
      esac
      jq -n --arg f "${path}" --arg s "${s}" --argjson a "${add:-0}" --argjson d "${del:-0}" --arg prev "${prev}" \
        '{filename:$f,status:$s,additions:$a,deletions:$d,previous_filename:$prev}' >> "${files_file}.jsonl"
    done
    exec 3<&- 4<&-
    if [[ "${join_ok}" == "true" ]]; then
      jq -s '.' "${files_file}.jsonl" > "${files_file}" 2>/dev/null || echo '[]' > "${files_file}"
    else
      echo '[]' > "${files_file}"
      echo "::warning::local diff join failed; falling back to compare API."
      local_diff=false
    fi
  else
    echo '[]' > "${files_file}"
    echo "::warning::local git diff failed; falling back to compare API."
    local_diff=false
  fi
fi
files_failed=false
if [[ "${local_diff}" != "true" ]]; then
  files_source="compare"
  compare_file="${RUNNER_TEMP}/muse-compare.json"
  if ! gh api "repos/${GITHUB_REPOSITORY}/compare/${base_sha}...${HEAD_SHA_EVENT}" \
    > "${compare_file}" 2>"${RUNNER_TEMP}/muse-ghcompare.err"; then
    echo '{"files":[]}' > "${compare_file}"
    echo "::warning::compare metadata failed: $(head -c 300 "${RUNNER_TEMP}/muse-ghcompare.err" 2>/dev/null || true)"
    # Missing file list means missing scoped guidance: diff.sh routes to the
    # explicit fallback rather than reviewing blind.
    files_failed=true
  fi
  jq '.files // []' "${compare_file}" > "${files_file}"
fi

# Changed-file summary with a hard budget. Filenames are untrusted (Git
# allows newlines); @tsv backslash-escapes them so records stay one-per-line,
# and the summary is wrapped in an explicitly untrusted block in the prompt.
total_files="$(jq -r 'length' "${files_file}")"
files_summary="$(jq -r '.[0:200][] | [.filename, .status, .additions, .deletions] | @tsv' "${files_file}" \
  | while IFS=$'\t' read -r name status add del; do
      printf -- '- %s [%s] +%s/-%s\n' "${name}" "${status}" "${add}" "${del}"
    done)"
if [[ -z "${files_summary}" ]]; then
  files_summary="- No file-level diff metadata was returned by the GitHub API."
fi
files_note=""
if [[ "${files_source}" == "compare" ]] && (( total_files >= 300 )); then
  files_note=" (PARTIAL SCOPE: file list capped at 300 by the compare API — manifest, guidance, and verdict may miss files)"
fi
if (( total_files > 200 )); then
  files_note="${files_note} ($(( total_files - 200 )) more files omitted from summary)"
fi
if (( $(printf '%s' "${files_summary}" | wc -c) > 8000 )); then
  tmp_sum="$(mktemp)"
  printf '%s' "${files_summary}" > "${tmp_sum}"
  files_summary="$(head -c 8000 "${tmp_sum}" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true)"
  rm -f "${tmp_sum}"
  files_note="${files_note} [summary truncated at 8000 bytes]"
fi
# Neutralize block-closing tags smuggled in filenames (@tsv does not escape
# angle brackets).
files_summary="$(printf '%s' "${files_summary}" | neutralize_tags)"
printf '%s\n' "${files_summary}" > "${RUNNER_TEMP}/muse-summary.txt"

# Full path manifest: the detailed summary above is entry-capped, so list
# EVERY changed path separately (bounded by bytes). The agent has no shell —
# without this, files past the cap and outside the truncated diff are
# undiscoverable.
manifest_file="${RUNNER_TEMP}/muse-manifest.txt"
jq -r '.[].filename | gsub("\n"; "\\n")' "${files_file}" > "${manifest_file}" 2>/dev/null \
  || : > "${manifest_file}"
manifest_note=""
if (( $(wc -c < "${manifest_file}") > 65536 )); then
  cap_file "${manifest_file}" 65536
  manifest_note=" [manifest truncated at 65536 bytes — PARTIAL SCOPE]"
fi

# Inter-phase state. %q quoting keeps newlines/quotes/unicode source-safe.
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_HEAD_SHA=%q\n' "${head_sha}"
  printf 'MUSE_BASE_REF=%q\n' "${base_ref}"
  printf 'MUSE_BASE_SHA_FULL=%q\n' "${base_sha_full}"
  printf 'MUSE_BASE_SHA=%q\n' "${base_sha}"
  printf 'MUSE_HEAD_REF=%q\n' "${head_ref}"
  printf 'MUSE_PR_TITLE=%q\n' "${pr_title}"
  printf 'MUSE_PR_BODY=%q\n' "${pr_body}"
  printf 'MUSE_FILES_SOURCE=%q\n' "${files_source}"
  printf 'MUSE_FILES_NOTE=%q\n' "${files_note}"
  printf 'MUSE_MANIFEST_NOTE=%q\n' "${manifest_note}"
  printf 'MUSE_BASE_AVAILABLE=%q\n' "${base_available}"
  printf 'MUSE_DEFAULT_BRANCH=%q\n' "${default_branch}"
  printf 'MUSE_FILES_FAILED=%q\n' "${files_failed}"
  printf 'MUSE_MERGE_BASE=%q\n' "${merge_base}"
  capped=false
  if [[ "${files_source}" == "compare" ]] && (( total_files >= 300 )); then capped=true; fi
  printf 'MUSE_FILES_CAPPED=%q\n' "${capped}"
} > "${RUNNER_TEMP}/muse-vars.env"
