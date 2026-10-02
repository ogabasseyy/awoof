# Shared pure helpers for the Muse review workflow.
# shellcheck shell=bash
#
# Sourced (never executed) by collect.sh, diff.sh, guidance.sh, prompt.sh,
# run.sh, post.sh, and test.sh. Portable to bash 3.2 (macOS) and bash 5
# (runner): no associative arrays, no mapfile, no namerefs.
#
# Every function here is pure (stdin/stdout/args only, no network, no repo
# state) so test.sh can exercise each one deterministically.

# YAML<->scripts contract version. The workflow YAML and these helpers
# evolve together (step outputs, env inputs, RUNNER_TEMP inter-phase
# files): runs pair same-commit YAML and scripts (the job `if` admits
# only default-base PRs), and the handshake is defense in depth so a
# contract change in between would fail closed instead of running
# silently against stale orchestration and skipping or mis-posting.
# The workflow's scriptdir step requires this exact value and fails
# closed (scripts_ok=false) on mismatch. Bump this AND the YAML's
# expected_protocol together with any contract change; test.sh asserts
# same-revision agreement.
# shellcheck disable=SC2034  # consumed by the workflow handshake + test.sh
MUSE_REVIEW_PROTOCOL=1

# Escape block-closing tags (</diff>, </file>, ...) so submitter-controlled
# text cannot break out of its prompt block. Single unified tag list for all
# blocks — neutralizing more is strictly safer than less.
neutralize_tags() {
  perl -pe 's{<\s*/\s*(file|diff|pr_title|pr_description|changed_files|removed_lines|symlink_targets|head_ref|base_ref|untrusted_guidance)}{<\\/$1}gi'
}

# In-place byte cap for a file. Only replaces the original when truncation
# succeeds, so a failed head/iconv can never clobber evidence with a
# partial file. Prints nothing; returns nonzero when the file is unreadable.
cap_file() {
  local _file="$1" _cap="$2" _tmp
  [[ -r "${_file}" ]] || return 1
  if (( $(wc -c < "${_file}") > _cap )); then
    _tmp="${_file}.trunc.$$"
    if head -c "${_cap}" "${_file}" | iconv -c -f UTF-8 -t UTF-8 > "${_tmp}" 2>/dev/null; then
      mv "${_tmp}" "${_file}"
    else
      rm -f "${_tmp}"
      return 1
    fi
  fi
}

# Byte-bounded UTF-8-safe truncation of a string, with an explicit marker.
# head reads a temp FILE (never a live pipe) so no writer can SIGPIPE;
# iconv -c drops a split trailing multibyte char. Bash ${var:0:N} is
# char-based and would overshoot byte budgets on non-ASCII text.
bound_untrusted() {
  local _in="$1" _cap="$2" _tmp
  if (( $(printf '%s' "${_in}" | wc -c) > _cap )); then
    _tmp="$(mktemp)"
    printf '%s' "${_in}" > "${_tmp}"
    printf '%s\n[... truncated at %s bytes ...]' \
      "$(head -c "${_cap}" "${_tmp}" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true)" "${_cap}"
    rm -f "${_tmp}"
  else
    printf '%s' "${_in}"
  fi
}

# Byte-bounded UTF-8-safe truncation of stdin (no marker). Same temp-file
# discipline as bound_untrusted.
trunc_bytes() {
  local bytes="$1" tmp
  tmp="$(mktemp)"
  cat > "${tmp}"
  head -c "${bytes}" "${tmp}" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true
  rm -f "${tmp}"
}

# Break @-mentions so a prompt-injected model cannot spam notifications via
# text posted as github-actions[bot]. A zero-width space after a
# start/whitespace-anchored @ keeps the text readable while defeating
# mention parsing; mid-word @ (emails, decorators) is left alone. Links are
# intentionally kept: doc citations are the recency feature working as
# designed. Apply after redact(), before byte-bounding (it adds characters).
sanitize_mentions() {
  # \xE2\x80\x8B is U+200B ZERO WIDTH SPACE as raw bytes: breaks mention
  # parsing while rendering invisibly, with no wide-char warnings. The
  # anchor mirrors GitHub's own mention boundary: @ linkifies unless
  # preceded by a word char, so the guard breaks @ after anything else —
  # punctuation contexts like (@u), ":@u", or `/@u` included — instead of
  # enumerating punctuation that always misses one more char. Mid-word @
  # (emails, decorators) is left alone.
  perl -pe 's/(?<![A-Za-z0-9_])@([A-Za-z0-9_])/\@\xE2\x80\x8B$1/g'
}

# Strip image embeds from review text posted as github-actions[bot]: a
# prompt-injected model could otherwise plant tracking pixels (or URLs
# carrying review content) that every PR viewer silently fetches.
# Regular links are intentionally preserved — doc citations are the
# recency feature working as designed; only the fetch-on-render image
# forms go. Alt text is kept so model intent stays readable. Shortcut
# reference images (`![label]` + `[label]: url`) degrade to plain links:
# no auto-fetch, still readable, same as any citation. Apply with
# sanitize_mentions(), before byte-bounding.
strip_images() {
  # All three ![...] forms match balanced brackets/parens to any depth
  # via self-recursive groups ((?2), (?3), (?4)): GFM accepts nested
  # balanced brackets in descriptions and parens in destinations, so a
  # flat [^\]]* alt would leave ![outer [inner]](.../pixel) for the
  # renderer to fetch. Each alternative starts with a disjoint char
  # (plain char vs backslash escape vs bracket/paren group) and plain
  # runs are possessive (++), keeping the match linear. Slurp mode
  # (-0777): link text may span lines, and a line-oriented filter would
  # miss a multiline image token entirely. Unbalanced tokens match
  # nothing and (like GFM itself) are left alone.
  perl -0777 -pe 's{!\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?2))*\]))*)\]\(((?:[^()\\]++|\\.|(\((?:[^()\\]++|\\.|(?4))*\)))*)\)}{$1}g; s{!\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?2))*\]))*)\]\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?4))*\]))*)\]}{$1}g; s{!(\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?3))*\]))*)\])(?!\()}{$1}g; s{<\s*img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>}{$1}gi; s{<\s*img\b[^>]*\balt\s*=\s*'"'"'([^'"'"']*)'"'"'[^>]*>}{$1}gi; s{<\s*img\b[^>]*>}{}gi'
}

# Remove every symlink under a workspace root (except .git) and print the
# count. No trusted-scripts carve-out: trusted helpers stage outside the
# reviewed workspace (RUNNER_TEMP), so every path the agent reads is
# untrusted by construction. The agent runs with META_API_KEY in its
# environment and is told to read changed files: a PR-added symlink such as
# leak.txt -> /proc/self/environ would otherwise expose the key to the model
# and its web tools, and --disable-shell does not stop filesystem reads.
# find without -L never follows links; rm -f on a link removes the link
# only. Unpopulated gitlinks need no handling: submodules are never checked
# out, so they read as empty dirs.
sweep_workspace_symlinks() {
  local _root="$1" _removed=0 _link
  while IFS= read -r -d '' _link; do
    if rm -f -- "${_link}"; then _removed=$((_removed + 1)); fi
  done < <(find "${_root}" -path "${_root}/.git" -prune -o -type l -print0 2>/dev/null)
  printf '%d' "${_removed}"
}

# Changed-path symlink targets, one `path -> target` line per link, for the
# review input. The agent runs symlink-blind (the sweep above removes every
# workspace link before the key is exposed), the manifest records paths only,
# and a changed link's hunk can fall past the diff cap — without this, the
# run would publish success over an unseen target. Record BEFORE the sweep.
# Targets are untrusted (readlink output on submitter-controlled paths):
# newlines flattened like the manifest, each target cut at 500 bytes, and
# the caller neutralizes tags and bounds the whole block. Prints at most
# _max entries; returns 2 when more changed symlinks exist (caller marks
# PARTIAL), 1 when the inventory is unreadable. Absolute and ..-carrying
# paths are skipped: joined onto the root they could resolve outside the
# checkout (same containment rule as head_readable).
changed_symlinks() {
  local _files="$1" _root="$2" _max="${3:-50}" _count=0 _f _t
  jq -e 'type == "array"' "${_files}" >/dev/null 2>&1 || return 1
  while IFS= read -r -d '' _f; do
    case "${_f}" in /*|..|../*|*/../*|*/..) continue ;; esac
    [[ -L "${_root}/${_f}" ]] || continue
    _count=$((_count + 1))
    if (( _count > _max )); then return 2; fi
    _t="$(readlink -- "${_root}/${_f}" 2>/dev/null || true)"
    _t="$(printf '%s' "${_t}" | trunc_bytes 500)"
    printf '%s -> %s\n' "${_f//$'\n'/\\n}" "${_t//$'\n'/\\n}"
  done < <(jq -j '[.[] | .filename // empty] | map(select(type == "string"))[] + "\u0000"' "${_files}" 2>/dev/null)
}

# True when a head-tree candidate is safe to read: a regular file, not a
# symlink itself, with no symlinked ancestor directory, and contained in
# the workspace. Checking only the final path would let a PR-added symlink
# farm (e.g. docs/ -> /etc) smuggle runner files into the prompt via
# docs/AGENTS.md. Containment is enforced without realpath (macOS lacks
# realpath -e): relative-only plus no .. segment means the path cannot
# resolve outside the checkout the caller runs in. Pure bash (no
# realpath/readlink -f) for macOS/Linux portability.
head_readable() {
  local _p="$1" _d
  case "${_p}" in
    /*|..|../*|*/..|*/../*) return 1 ;;
  esac
  [[ -f "${_p}" && ! -L "${_p}" ]] || return 1
  _d="${_p}"
  while [[ "${_d}" == */* ]]; do
    _d="${_d%/*}"
    [[ -L "${_d}" ]] && return 1
  done
  return 0
}

# Scrub secret patterns from review text before it is posted publicly.
# Private keys redact as full header-to-footer blocks; provider prefixes,
# JWTs, and key-assignment pairs (api_key="...", token: ...) redact by
# value. When META_API_KEY is present in the environment (run step only),
# its literal value is masked first, covering bare echoes in any format;
# the length guard matters because an empty pattern would match everywhere.
# The post step deliberately never receives the key: masking there would
# widen its exposure, and every key-derived byte reaching it already passed
# through this function in the run step. Always redact BEFORE truncating:
# cutting first could remove a PEM footer and defeat the full-block match.
redact() {
  printf '%s' "$1" | META_API_KEY="${META_API_KEY:-}" perl -0777 -pe 'BEGIN { $k = $ENV{META_API_KEY} // q{} } if (length $k) { $q = quotemeta($k); s/$q/[REDACTED]/g } s/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/[REDACTED-PRIVATE-KEY]/gs; s/\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[A-Za-z]-|AKIA)[A-Za-z0-9_\-]+/[REDACTED]/g; s/\bAIza[0-9A-Za-z_\-]{35}/[REDACTED]/g; s/eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/[REDACTED-JWT]/g; s/((?:api[_-]?key|secret|token|password)\s*[:=]\s*["'"'"']?)[A-Za-z0-9_\-.\/+]{12,}/${1}[REDACTED]/gi'
}

# Mask the live META_API_KEY inside DECODED JSON string values (stdin to
# stdout). Byte substitution misses a key hidden behind legal JSON escapes
# (e.g. \u003d for =, \/ for /): the raw bytes never match, but a later
# `jq -r` in the keyless post step decodes them back to the live value and
# publishes it. So while the key is still available (run step only), parse
# the model output as JSON, redact inside decoded strings, reserialize.
# Returns nonzero when the key is empty/unset or the input is not valid
# JSON — the caller then falls back to byte substitution. The key travels
# via jq --arg (never interpolated into the program); split/join replaces
# literally (gsub would read key bytes as regex); walk covers nested
# strings at any depth. Deterministic: same input key/output every run.
redact_json_key() {
  local _key="${META_API_KEY:-}"
  [[ -n "${_key}" ]] || return 1
  jq --arg k "${_key}" 'walk(if type == "string" then (. | split($k) | join("[REDACTED]")) else . end)'
}

# Decode JSON escape sequences in possibly-mixed text (stdin to stdout).
# redact_json_key needs the WHOLE input to be one valid JSON value, so prose
# around a JSON fragment (e.g. `error: {"key":"live\/key\u003dabc"}`) fails
# the parse and byte redaction then misses the reversible escaped key. Run
# this before redact() on the non-JSON path so escaped bytes match too. The
# lookbehind keeps an escaped backslash (`\\u003d`) intact instead of
# decoding what JSON itself would leave literal. Aggressive by design: any
# over-decoding only over-redacts, never leaks.
decode_json_escapes() {
  perl -pe 's/(?<!\\)\\u([0-9a-fA-F]{4})/chr(hex($1))/ge; s/(?<!\\)\\\//\//g'
}

# Changed-path manifest lines from a PR-files JSON array: one escaped path
# per line. Backslashes escape FIRST, then newlines — escaping newlines
# alone maps `a<LF>b` and a literal `a\nb` to the same bytes, so the
# shell-disabled reviewer could miss a file it cannot re-derive. Mirrors
# jq @tsv (which the changed-files summary already relies on).
manifest_paths() {
  jq -r '.[].filename | gsub("\\\\"; "\\\\") | gsub("\n"; "\\n")' "$1" 2>/dev/null
}

# Guidance trust: a PR base branch is contributor-controlled unless it is the
# repo default branch, so only default-branch base content earns "trusted"
# status; stacked-PR and custom bases stay isolated as UNTRUSTED. Prints
# true/false. Fails closed on unknown default branch.
trust_base() {
  local _base_ref="$1" _default="$2" _available="$3"
  if [[ "${_available}" == "true" && -n "${_default}" && "${_base_ref}" == "${_default}" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# Candidate identity without newline mangling. Newline-delimited seen-files
# break when a directory contains a newline (one candidate becomes several
# apparent lines and can suppress a real later candidate), so identity lives
# in an indexed array compared exactly — no serialization, no assoc arrays
# (bash 3.2 compatible). Callers iterate MUSE_CANDIDATES in order.
MUSE_SEEN=()
MUSE_CANDIDATES=()
seen_reset() {
  MUSE_SEEN=()
  MUSE_CANDIDATES=()
}
seen_add() {
  local _candidate="$1" _known
  for _known in "${MUSE_SEEN[@]+"${MUSE_SEEN[@]}"}"; do
    if [[ "${_known}" == "${_candidate}" ]]; then return 0; fi
  done
  MUSE_SEEN+=("${_candidate}")
  MUSE_CANDIDATES+=("${_candidate}")
}
