#!/usr/bin/env bash
# Invoke the Muse agent headlessly and capture its structured review.
#
# This step's environment carries NO GitHub token (the guard step owns the
# head check): the agent authenticates only via META_API_KEY, and both token
# vars are scrubbed from its environment as defense in depth.
#
# Env in: META_API_KEY, PROMPT_FILE, MUSE_MODEL, MUSE_EFFORT, RUNNER_TEMP,
#   GITHUB_WORKSPACE, GITHUB_OUTPUT, SCRIPT_DIR.
# Output: review_file. Exits nonzero when the agent fails so the step outcome
# stays truthful (the step uses continue-on-error; Post renders a fallback).
set -euo pipefail

# shellcheck disable=SC1091  # SCRIPT_DIR is set by the workflow step
. "${SCRIPT_DIR}/lib.sh"

review_file="${RUNNER_TEMP}/muse-review-body.md"
: > "${review_file}"

# Materialize a symlink-free workspace BEFORE the key is exposed: the agent
# inherits META_API_KEY and reads changed files, so any PR-added symlink
# (e.g. to /proc/self/environ) must already be gone. Count is logged; the
# agent simply finds those paths missing.
swept="$(sweep_workspace_symlinks "${GITHUB_WORKSPACE}")"
if (( swept > 0 )); then
  echo "::notice::Removed ${swept} workspace symlink(s) before the agent run."
fi

model_args=()
if [[ -n "${MUSE_MODEL}" ]]; then
  model_args+=(--model "${MUSE_MODEL}")
fi

# Residual risk (accepted, documented): the agent holds META_API_KEY with
# web tools ON and this runner has no egress firewall, so a prompt-injected
# model could exfiltrate the key over the network despite --disable-shell /
# --disable-write (those stop local writes, and the symlink sweep above
# stops filesystem-read exfil, but neither constrains fetch). Mitigations in
# place: the prompt forbids transmitting secrets, output is redacted before
# posting, and the key should be dedicated to this workflow (Meta keys
# are team-scoped; no narrower scope exists) and rotated on any
# suspicious review output. Full containment would need runner-level egress
# filtering, which stock GitHub-hosted runners do not offer.
# Workspace trust is deliberately left UNRESOLVED (no --trust-workspace):
# trusting would load the PR checkout's own skills, rules, and hooks
# into the key-holding agent. Headless exec on a fresh runner HOME
# proceeds in the untrusted state instead — project rules are ignored
# by the CLI and the applicable guidance reaches the model through the
# assembled prompt — so no trust prompt can stall the run and no
# PR-controlled configuration executes. Verified against the pinned
# CLI on a fresh HOME: the run starts, notes the untrusted workspace,
# and completes.
set +e
env -u GITHUB_TOKEN -u GH_TOKEN "${HOME}/.local/bin/muse" exec \
  --prompt-file "${PROMPT_FILE}" \
  --workspace "${GITHUB_WORKSPACE}" \
  --reasoning-effort "${MUSE_EFFORT}" \
  --max-model-steps 35 \
  --disable-approval \
  --disable-write \
  --disable-shell \
  --no-session-log \
  --output-schema "${SCRIPT_DIR}/schema.json" \
  "${model_args[@]}" </dev/null > "${review_file}" 2>"${RUNNER_TEMP}/muse-stderr.log"
muse_rc=$?
set -e

echo "review_file=${review_file}" >> "${GITHUB_OUTPUT}"

if (( muse_rc != 0 )); then
  echo "::warning::muse exec exited ${muse_rc}; stderr tail follows"
  # Redact-then-truncate like review bodies: the raw tail could carry
  # secrets a misbehaving model echoed to stderr. JSON-aware pass first
  # while the key is available: byte substitution misses a key hidden
  # behind legal JSON escapes (\u003d, \/), which would otherwise be
  # reconstructible from the Actions log. The whole-input JSON parse fails
  # on mixed prose around a JSON fragment, so the fallback decodes escape
  # sequences first — without that, the reversible escaped key survives.
  # Neutralize LAST, closest to the channel: decoding can turn
  # `\u000a\u003a\u003aerror...` into a line starting with `::error`,
  # which the runner would execute as a workflow command on print.
  stderr_clean="$(mktemp)"
  if redact_json_key < "${RUNNER_TEMP}/muse-stderr.log" > "${stderr_clean}" 2>/dev/null; then
    :
  else
    decode_json_escapes < "${RUNNER_TEMP}/muse-stderr.log" > "${stderr_clean}" 2>/dev/null || : > "${stderr_clean}"
  fi
  # Strip ANSI controls first: log viewers render them as styling and
  # hide the bytes, so an escape-split key would display contiguously
  # while every redaction pass saw only halves. Removing the sequences
  # joins the halves where the key-aware passes below can match them.
  # Redact again after neutralize: CR handling there is the last
  # byte-changing filter before the log, so a second key-aware pass
  # (redact itself strips CRs before matching) catches any credential
  # a CR split hid from the first pass.
  redact "$(redact "$(strip_ansi < "${stderr_clean}" 2>/dev/null || true)" | tail -c 4000 | neutralize_workflow_commands)"
  rm -f "${stderr_clean}"
  exit "${muse_rc}"
fi

# Mask the live key value in the captured output while it is still in this
# key-holding step: a bare echoed value matches no static pattern, and the
# post step deliberately never receives the key to match it. Failure here
# fails the step so an unmasked body is never posted (Post renders the
# no-output fallback instead).
#
# JSON-aware pass first: raw byte substitution misses a key hidden behind
# legal JSON escapes (\u003d, \/), which post.sh's `jq -r` would decode
# back to the live value in the keyless step. Redacting inside decoded
# strings closes that hole; the byte pass below stays as the fallback for
# non-JSON output and values outside JSON strings. The fallback decodes
# escapes first: mixed prose around a JSON fragment fails the whole-input
# parse, and the reversible escaped key would otherwise survive to the post.
if redact_json_key < "${review_file}" > "${review_file}.clean" 2>/dev/null; then
  mv "${review_file}.clean" "${review_file}"
else
  rm -f "${review_file}.clean"
  decode_json_escapes < "${review_file}" > "${review_file}.decoded" 2>/dev/null \
    && mv "${review_file}.decoded" "${review_file}" || rm -f "${review_file}.decoded"
fi
# Strip image markup BEFORE the final byte redaction: the post step
# strips images as presentation filtering, and deleting a token that
# splits the key would rejoin it after the last key-aware pass (the
# same rejoin class as the NUL case). Stripping here — the post strip
# is idempotent — keeps every byte-removing filter ahead of redaction.
if strip_images < "${review_file}" > "${review_file}.noimg" 2>/dev/null; then
  mv "${review_file}.noimg" "${review_file}"
else
  rm -f "${review_file}.noimg"
fi
# Neutralize HTML character references BEFORE the final key-aware pass:
# GFM renders &#65; as A, so an entity-encoded character of the live key
# matches neither the JSON-aware nor the literal redaction, yet the
# posted review would visibly reconstruct the credential (the keyless
# post step preserves entities). Escaping the & shows the reference
# literally instead.
if neutralize_html_entities < "${review_file}" > "${review_file}.noent" 2>/dev/null; then
  mv "${review_file}.noent" "${review_file}"
else
  rm -f "${review_file}.noent"
fi
# Replace raw HTML tags before the final key-aware pass for the same
# reason: GFM renders inline raw HTML, so `left<span></span>right`
# displays as the joined credential even though every redaction pass
# saw only halves (the post step repeats this as presentation defense).
if strip_html_tags < "${review_file}" > "${review_file}.notags" 2>/dev/null; then
  mv "${review_file}.notags" "${review_file}"
else
  rm -f "${review_file}.notags"
fi
# Remove render-empty Markdown links before the final pass for the same
# reason: `left[]()right` renders as "leftright" (empty anchor), while
# strip_images above covers only the image form.
if strip_empty_links < "${review_file}" > "${review_file}.nolinks" 2>/dev/null; then
  mv "${review_file}.nolinks" "${review_file}"
else
  rm -f "${review_file}.nolinks"
fi
# Remove intraword formatting runs before the final pass: intraword
# emphasis/code markers render hidden (`left*A*right` displays as the
# joined credential), and only intraword runs can join a split value.
if strip_intraword_markers < "${review_file}" > "${review_file}.nomarks" 2>/dev/null; then
  mv "${review_file}.nomarks" "${review_file}"
else
  rm -f "${review_file}.nomarks"
fi
redact "$(cat "${review_file}")" > "${review_file}.clean" && mv "${review_file}.clean" "${review_file}"
