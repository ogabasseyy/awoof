#!/usr/bin/env bash
# Validate the agent output, render the summary plus inline threads, and post.
#
# Env in: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, BASE_SHA,
#   HEAD_SHA_EVENT, BASE_SHA_EVENT, MUSE_OUTCOME, DIFF_FAILED, DIFF_OUTCOME,
#   REVIEW_FILE, RUN_URL, RUNNER_TEMP, SCRIPT_DIR.
# Advisory to the end: a failed POST warns, never fails the job.
set -euo pipefail

# Event-SHA fallback: when evidence collection itself failed, the step
# outputs are unset, but the marker and commit_id still need values.
# Remaining step outputs default fail-closed (unset reads would die under
# set -u exactly when the fallback path needs them most).
: "${HEAD_SHA:=${HEAD_SHA_EVENT}}"
: "${BASE_SHA:=${BASE_SHA_EVENT}}"
: "${REVIEW_FILE:=}"
: "${DIFF_FAILED:=false}"
: "${MUSE_OUTCOME:=skipped}"
: "${DIFF_OUTCOME:=failure}"

# shellcheck disable=SC1091  # SCRIPT_DIR is set by the workflow step
. "${SCRIPT_DIR}/lib.sh"

# Second staleness gate (see guard.sh): skip quietly when head or base
# moved mid-run (findings would misattribute), the PR became a draft
# (drafts are excluded, and conversion changes neither SHA), the PR
# closed or merged (closing changes neither SHA nor draft), or the
# lookup fails.
if ! live_shas="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq '[.head.sha, .base.sha, .draft, .state] | @tsv' 2>/dev/null)" \
  || [[ -z "${live_shas}" ]]; then
  echo "::warning::Head revalidation lookup failed; skipping post to avoid publishing a stale review."
  exit 0
fi
live_head="${live_shas%%$'\t'*}"; live_rest="${live_shas#*$'\t'}"
live_base="${live_rest%%$'\t'*}"; live_rest="${live_rest#*$'\t'}"
live_draft="${live_rest%%$'\t'*}"; live_state="${live_rest#*$'\t'}"
if [[ "${live_head}" != "${HEAD_SHA}" ]]; then
  echo "::notice::PR head moved during review (${HEAD_SHA:0:10} -> ${live_head:0:10}); skipping stale post."
  exit 0
fi
if [[ "${live_base}" != "${BASE_SHA}" ]]; then
  echo "::notice::PR base moved during review (${BASE_SHA:0:10} -> ${live_base:0:10}); skipping stale post."
  exit 0
fi
if [[ "${live_draft}" == "true" ]]; then
  echo "::notice::PR was converted to draft during review; skipping post."
  exit 0
fi
if [[ "${live_state}" != "open" ]]; then
  echo "::notice::PR is no longer open (state: ${live_state}); skipping post."
  exit 0
fi

body_file="${RUNNER_TEMP}/muse-review.md"
marker="<!-- muse-code-review sha:${HEAD_SHA} base:${BASE_SHA:0:10} -->"
# GitHub rejects review bodies past 65536 chars; stay below with headroom.
body_budget=60000

# Render the summary from the validated findings (globals: verdict,
# validated_json, findings_json). Full mode prints every summary-only body;
# compact mode keeps every finding header but omits the bodies with an
# explicit note — used when the full render exceeds the post budget, so no
# finding is ever silently dropped by a byte cut. Inline threads are
# unaffected (they render separately), so compacted findings keep their
# "(see inline)" pointers.
render_summary() {
  local _mode="$1"
  {
    printf '## Verdict\n\n%s\n\n## Findings\n\n' "${verdict}"
    total_findings="$(jq -r '(.valid|length) + (.summary_only|length)' "${validated_json}")"
    if [[ "${total_findings}" == "0" ]]; then
      printf '%s\n' "- No meaningful issues found."
    fi
    while IFS=$'\t' read -r sev title path line; do
      printf '%s\n' "- ${sev}: ${title} in ${path}:${line} (see inline)"
    done < <(jq -r '.valid[]? | [(.severity // "low" | gsub("\t"; " ")), (.title // "" | gsub("\t"; " ")), (.path // "" | gsub("\t"; " ") | gsub("\n"; " ")), (.line // 0)] | @tsv' "${validated_json}")
    while IFS=$'\t' read -r sev title path line body orphaned; do
      if [[ "${orphaned}" == "true" ]]; then
        printf '%s\n' "- ${sev}: ${title} in ${path}:${line} (path not in changed files — unverified)"
      else
        printf '%s\n' "- ${sev}: ${title} in ${path}:${line}"
      fi
      if [[ "${_mode}" == "compact" ]]; then
        printf '  %s\n' "(details omitted: full review exceeded the ${body_budget}-byte post budget)"
      else
        printf '  %s\n' "${body}"
      fi
    done < <(jq -r '.summary_only[]? | [(.severity // "low" | gsub("\t"; " ")), (.title // "" | gsub("\t"; " ")), (.path // "" | gsub("\t"; " ") | gsub("\n"; " ")), (.line // 0), ((.body // "") | gsub("\n"; " ") | gsub("\t"; " ")), (.orphaned // false)] | @tsv' "${validated_json}")
    printf '\n## Suggested next steps\n\n'
    jq -r '.next_steps[]?' "${findings_json}" 2>/dev/null | while IFS= read -r step; do
      printf '%s\n' "- ${step}"
    done
  } > "${RUNNER_TEMP}/muse-summary.md"
}

# Scrub secrets from the review body before posting (prompt is partly
# attacker-controlled; see lib.sh redact). Redact BEFORE sanitizing and
# budget checks (both can defeat the full-block match or add characters).
sanitize_review() {
  review="$(redact "${review}")"
  review="$(printf '%s' "${review}" | strip_images | sanitize_mentions)"
}

review=""
inline_payload='[]'
raw_output=""
is_fallback=false
if [[ -f "${REVIEW_FILE}" ]]; then
  raw_output="$(cat "${REVIEW_FILE}")"
fi
if [[ "${DIFF_OUTCOME}" != "success" ]]; then
  is_fallback=true
  review="## Verdict

Muse did not review this PR: evidence collection failed (step outcome:
\`${DIFF_OUTCOME}\`), so there was nothing to review.

## Findings

- low: No review was attempted because evidence collection failed —
  check the workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
elif [[ "${DIFF_FAILED}" == "true" ]]; then
  is_fallback=true
  review="## Verdict

Muse did not review this PR: diff collection failed, so there was no
evidence to review.

## Findings

- low: No review was attempted because diff collection failed —
  check the workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
elif [[ "${MUSE_OUTCOME}" != "success" ]]; then
  # Nonzero/skipped runs can leave partial output behind; never publish it
  # as a successful review (it would also poison dedupe).
  is_fallback=true
  review="## Verdict

Muse did not return a review (step outcome: \`${MUSE_OUTCOME}\`).

## Findings

- low: No review content was produced. This is often a quota, auth,
  or install issue — check the workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
elif printf '%s' "${raw_output}" | jq -e '(.verdict | type) == "string" and (.findings | type) == "array" and ((.next_steps // []) | type) == "array"' >/dev/null 2>&1; then
  # Structured path. Shape enforced (not presence): mistyped findings
  # would otherwise sail through cleanup and post a false "no issues".
  findings_json="${RUNNER_TEMP}/muse-findings.json"
  printf '%s' "${raw_output}" > "${findings_json}"
  # Normalize: keep only well-formed finding objects. ANY dropped finding
  # routes to the explicit fallback: posting the cleaned subset would
  # permanently hide the rejected finding behind a successful review.
  raw_finding_count="$(jq -r '(.findings // []) | length' "${findings_json}")"
  # Cleanup failure keeps NO findings, never the uncleaned original.
  if jq -f "${SCRIPT_DIR}/clean.jq" \
    "${findings_json}" > "${findings_json}.clean" 2>/dev/null; then
    mv "${findings_json}.clean" "${findings_json}"
    clean_finding_count="$(jq -r '(.findings // []) | length' "${findings_json}")"
  else
    rm -f "${findings_json}.clean"
    clean_finding_count=0
  fi
  if (( clean_finding_count < raw_finding_count )); then
    is_fallback=true
    review="## Verdict

Muse returned malformed findings that could not be validated, so no
review is posted as fact. See the workflow logs.

## Findings

- low: Model output failed finding-shape validation — check the
  workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
  else
  verdict="$(jq -r '.verdict // ""' "${findings_json}")"
  # Valid inline lines = new-side ranges of the collected diff.
  ranges_json="${RUNNER_TEMP}/muse-ranges.json"
  perl "${SCRIPT_DIR}/ranges.pl" "${RUNNER_TEMP}/muse.diff" > "${ranges_json}" 2>/dev/null || echo '[]' > "${ranges_json}"
  jq empty "${ranges_json}" 2>/dev/null || echo '[]' > "${ranges_json}"
  validated_json="${RUNNER_TEMP}/muse-validated.json"
  jq --slurpfile ranges "${ranges_json}" --slurpfile files "${RUNNER_TEMP}/muse-files.json" \
    -f "${SCRIPT_DIR}/validate.jq" \
    "${findings_json}" > "${validated_json}" 2>/dev/null || echo '{"valid":[],"summary_only":[]}' > "${validated_json}"
  render_summary full
  review="$(cat "${RUNNER_TEMP}/muse-summary.md")"
  # Inline thread bodies, redacted and bounded each.
  inline_jsonl="${RUNNER_TEMP}/muse-inline.jsonl"
  : > "${inline_jsonl}"
  while IFS= read -r finding; do
    f_sev="$(printf '%s' "${finding}" | jq -r '.severity // "low"')"
    case "${f_sev}" in critical|high|medium|low) ;; *) f_sev="low";; esac
    f_title="$(printf '%s' "${finding}" | jq -r '.title // ""')"
    f_path="$(printf '%s' "${finding}" | jq -r '.path // ""')"
    f_line="$(printf '%s' "${finding}" | jq -r '(.line|tonumber?) // 0')"
    f_body="$(printf '%s' "${finding}" | jq -r '.body // ""')"
    # Redact-then-bound for BOTH title and body: truncating first would cut
    # PEM footers and defeat the full-block regex.
    f_title="$(redact "${f_title}")"
    f_title="$(printf '%s' "${f_title}" | strip_images | sanitize_mentions | trunc_bytes 300)"
    thread_body="$(printf '**[%s] %s**\n\n%s\n\n<sub>Useful? React with 👍 / 👎.</sub>' "${f_sev}" "${f_title}" "${f_body}")"
    thread_body="$(redact "${thread_body}")"
    thread_body="$(printf '%s' "${thread_body}" | strip_images | sanitize_mentions | trunc_bytes 6000)"
    jq -n --arg path "${f_path}" --argjson line "${f_line}" --arg body "${thread_body}" \
      '{path: $path, line: $line, side: "RIGHT", body: $body}' >> "${inline_jsonl}"
  done < <(jq -c '.valid[]?' "${validated_json}")
  inline_payload="$(jq -s '.' "${inline_jsonl}" 2>/dev/null || echo '[]')"
  fi
elif [[ -z "${raw_output//[[:space:]]/}" ]]; then
  is_fallback=true
  review="## Verdict

Muse did not return a review (step outcome: \`${MUSE_OUTCOME}\`).

## Findings

- low: No review content was produced. This is often a quota, auth,
  or install issue — check the workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
else
  # The output schema constrains the agent to JSON; markdown here means the
  # model ignored it. Post an explicit fallback rather than unvalidated
  # prose (a prompt-injected model could otherwise force this path to
  # publish unvalidated claims and file/line references).
  is_fallback=true
  review="## Verdict

Muse returned markdown instead of the required JSON findings object, so no
review is posted as fact. See the workflow logs.

## Findings

- low: Model output failed finding-shape validation — check the
  workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
fi

sanitize_review

# Fit the posted body in budget WITHOUT dropping findings: a byte cut here
# would silently remove trailing findings while the success marker still
# posts (and pre-run dedupe would then block recovery on rerun). First
# re-render compactly — every finding header stays, only the summary-only
# bodies collapse to an explicit note. If headers alone still exceed the
# budget, route to the explicit fallback instead of posting a partial
# review as fact; the fallback tag keeps dedupe from blocking recovery.
if (( $(printf '%s' "${review}" | wc -c) > body_budget )); then
  if [[ "${is_fallback}" == "false" ]]; then
    render_summary compact
    review="$(cat "${RUNNER_TEMP}/muse-summary.md")"
    sanitize_review
  fi
  if (( $(printf '%s' "${review}" | wc -c) > body_budget )); then
    is_fallback=true
    review="## Verdict

Muse returned a review that exceeds the ${body_budget}-byte post budget
even in compact form, so no review is posted as fact. See the workflow
logs.

## Findings

- low: Model output exceeded the post budget — check the workflow logs.

## Suggested next steps

Re-run the workflow, or inspect the logs."
    sanitize_review
  fi
fi

{
  printf '%s\n' "${marker}"
  # Machine-readable fallback tag for dedupe: never infer fallback state
  # from review prose (a real review could quote it).
  if [[ "${is_fallback}" == "true" ]]; then
    printf '%s\n' "<!-- muse-fallback:v1 -->"
  fi
  cat <<EOF
## Muse code review (advisory)

Workflow: ${RUN_URL}
EOF
  printf '\n%s\n' "${review}"
} > "${body_file}"

# Post-time fallback dedupe (pre-run would kill succeeding reruns):
# same-SHA posts once; any fallback in the last 24h suppresses repeats.
if [[ "${is_fallback}" == "true" ]] \
  && gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" --paginate \
    > "${RUNNER_TEMP}/muse-reviews.json" 2>/dev/null; then
  if (( $(jq -s --arg marker "${marker}" -f "${SCRIPT_DIR}/fallback.jq" "${RUNNER_TEMP}/muse-reviews.json" 2>/dev/null || echo 0) > 0 )); then
    echo "::notice::Fallback already posted for ${HEAD_SHA:0:10}; skipping duplicate."
    exit 0
  fi
elif [[ "${is_fallback}" == "true" ]]; then
  echo "::warning::Fallback-dedupe lookup failed; posting anyway."
fi

payload_file="${RUNNER_TEMP}/muse-review-payload.json"
# shellcheck disable=SC2016  # $body / $sha / $comments are jq variables, not shell
jq -n \
  --rawfile body "${body_file}" \
  --arg sha "${HEAD_SHA}" \
  --argjson comments "${inline_payload}" \
  'if ($comments | length) == 0 then { body: $body, event: "COMMENT", commit_id: $sha }
    else { body: $body, event: "COMMENT", commit_id: $sha, comments: $comments } end' > "${payload_file}"

# Advisory: a failed POST warns, never fails. The endpoint is
# all-or-nothing, so retry once summary-only rather than lose the review.
post_resp="${RUNNER_TEMP}/muse-post-resp.txt"
if ! gh api --method POST \
  "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" \
  --input "${payload_file}" > "${post_resp}" 2>&1; then
  echo "::warning::Review POST failed: $(head -c 300 "${post_resp}" 2>/dev/null || true)"
  if [[ "${inline_payload}" != "[]" ]]; then
    # The first POST may have reached GitHub while its response was lost
    # (timeout, reset): review creation has no idempotency key, so a blind
    # retry would double-post. A landed attempt carries our marker — check
    # for it first, and skip the retry when the lookup itself fails rather
    # than risk a duplicate.
    marker_check="${RUNNER_TEMP}/muse-retry-check.json"
    if gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" --paginate \
        > "${marker_check}" 2>/dev/null; then
      if (( $(jq -s --arg marker "${marker}" -f "${SCRIPT_DIR}/dedupe.jq" "${marker_check}" 2>/dev/null || echo 1) > 0 )); then
        echo "::notice::First review POST landed despite the error; skipping retry."
        exit 0
      fi
    else
      echo "::warning::Retry-dedupe lookup failed; skipping retry to avoid a double-post."
      exit 0
    fi
    echo "::warning::Retrying as summary-only."
    # Reuse the rejected payload's already-sanitized bodies (paths
    # re-sanitized here, bodies capped with markers), minus dangling
    # "(see inline)" pointers; char-sliced back under the body limit.
    jq '.body |= gsub(" \\(see inline\\)"; "") |
        .body += "\n\n<sub>Inline threads were rejected by the API; findings inlined below.</sub>\n\n" +
          ([.comments[]? | "### \(.path | gsub("\\n"; " ") | gsub("!\\[[^\\]]*\\]\\([^\\)]*\\)"; "") | gsub("(?<![A-Za-z0-9_])@(?=[A-Za-z0-9_])"; "@\u200b")):\(.line)\n\n\(.body | gsub("\\n\\n<sub>Useful\\?.*"; "") | if length > 2000 then .[0:2000] + "\n\n[...explanation truncated for length...]" else . end)"] | join("\n\n---\n\n")) |
        .body |= .[0:60000] |
        del(.comments)' \
      "${payload_file}" > "${payload_file}.summary"
    # Retry bodies interpolate validated-but-untrusted paths: a filename
    # carrying <img> markup or nested-paren markdown-image syntax would
    # survive the jq-level path scrub above, so run the assembled body
    # through the same full filters as the first attempt (idempotent on
    # clean text). A filter failure keeps the jq-only body and still
    # attempts the retry rather than losing the review.
    if jq -r '.body' "${payload_file}.summary" 2>/dev/null \
      | strip_images | sanitize_mentions > "${RUNNER_TEMP}/muse-retry-body.txt" \
      && jq --rawfile body "${RUNNER_TEMP}/muse-retry-body.txt" '.body = $body' \
        "${payload_file}.summary" > "${payload_file}.summary.clean" 2>/dev/null; then
      mv "${payload_file}.summary.clean" "${payload_file}.summary"
    else
      rm -f "${payload_file}.summary.clean"
    fi
    if ! gh api --method POST \
      "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" \
      --input "${payload_file}.summary" >/dev/null 2>&1; then
      echo "::warning::Failed to post Muse review; see previous logs."
    fi
  else
    echo "::warning::Failed to post Muse review; see previous logs."
  fi
fi
