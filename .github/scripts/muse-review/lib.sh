# Shared pure helpers for the Muse review workflow.
# shellcheck shell=bash
#
# Sourced (never executed) by collect.sh, diff.sh, guidance.sh, prompt.sh,
# run.sh, post.sh, and test.sh. Portable to bash 3.2 (macOS) and bash 5
# (runner): no associative arrays, no mapfile, no namerefs.
#
# Every function here is pure (stdin/stdout/args only, no network, no repo
# state) so test.sh can exercise each one deterministically.

# Escape block-closing tags (</diff>, </file>, ...) so submitter-controlled
# text cannot break out of its prompt block. Single unified tag list for all
# blocks — neutralizing more is strictly safer than less.
neutralize_tags() {
  perl -pe 's{<\s*/\s*(file|diff|pr_title|pr_description|changed_files|removed_lines|head_ref|base_ref|untrusted_guidance)}{<\\/$1}gi'
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
  perl -pe 's/!\[([^\]]*)\]\((?:[^()]*|\([^()]*\))*\)/$1/g; s/!\[([^\]]*)\]\[[^\]]*\]/$1/g; s/!(\[[^\]]+\])(?!\()/$1/g; s{<\s*img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>}{$1}gi; s{<\s*img\b[^>]*\balt\s*=\s*'"'"'([^'"'"']*)'"'"'[^>]*>}{$1}gi; s{<\s*img\b[^>]*>}{}gi'
}

# Remove every symlink under a workspace root (except .git and the trusted
# scripts dir) and print the count. The agent runs with META_API_KEY in its
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
  done < <(find "${_root}" \( -path "${_root}/.git" -o -path "${_root}/trusted-scripts" \) -prune -o -type l -print0 2>/dev/null)
  printf '%d' "${_removed}"
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
# value. The assignment pattern is case-insensitive, so META_API_KEY=<val>
# echoes are already caught; a bare echoed value in an unknown format is
# unmatchable by static pattern — the live secret is deliberately never
# piped into this step to match it. Always redact BEFORE truncating:
# cutting first could remove a PEM footer and defeat the full-block match.
redact() {
  printf '%s' "$1" | perl -0777 -pe 's/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/[REDACTED-PRIVATE-KEY]/gs; s/\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[A-Za-z]-|AKIA)[A-Za-z0-9_\-]+/[REDACTED]/g; s/\bAIza[0-9A-Za-z_\-]{35}/[REDACTED]/g; s/eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/[REDACTED-JWT]/g; s/((?:api[_-]?key|secret|token|password)\s*[:=]\s*["'"'"']?)[A-Za-z0-9_\-.\/+]{12,}/${1}[REDACTED]/gi'
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
