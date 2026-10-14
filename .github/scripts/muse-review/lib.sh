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
  # Injective neutralization in one pass: every backslash in the run
  # before the closing slash doubles, then one protective backslash is
  # added and the original whitespace is preserved verbatim — `</diff>`,
  # `< /diff>`, `</ diff>`, and `<\/diff>` are four distinct source byte
  # strings and stay four distinct outputs. Backslashes elsewhere (e.g.
  # \xFF evidence escapes) pass through untouched.
  perl -pe 's{<(\\*)(\s*)/(\s*)(file|diff|pr_title|pr_description|changed_files|removed_lines|symlink_targets|gitlink_targets|changed_modes|head_ref|base_ref|untrusted_guidance)}{"<" . ("\\" x (2 * length($1))) . $2 . "\\/" . $3 . $4}gie'
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
  # nothing and (like GFM itself) are left alone. The whole sequence
  # repeats to a fixed point: removing HTML can form a new markdown
  # image (e.g. `!<img>[]()`) that a single pass would leave for a
  # later keyless pass to remove and rejoin split text. Every change
  # strictly shortens the input, so the loop needs no iteration ceiling
  # to converge — a cap would only leave deeper nestings unstripped.
  perl -0777 -pe 'while (1) { $p=$_; s{!\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?2))*\]))*)\]\(((?:[^()\\]++|\\.|(\((?:[^()\\]++|\\.|(?4))*\)))*)\)}{$1}g; s{!\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?2))*\]))*)\]\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?4))*\]))*)\]}{$1}g; s{!(\[((?:[^\[\]\\]++|\\.|(\[(?:[^\[\]\\]++|\\.|(?3))*\]))*)\])(?!\()}{$1}g; s{<\s*img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>}{$1}gi; s{<\s*img\b[^>]*\balt\s*=\s*'"'"'([^'"'"']*)'"'"'[^>]*>}{$1}gi; s{<\s*img\b[^>]*>}{}gi; last if $_ eq $p; }'
}

# Replace render-hidden HTML comments with a nonempty separator: GitHub
# hides <!-- ... --> content when rendering Markdown, so a credential
# split as `ghp_left<!-- x -->right` would visibly reconstruct in the
# posted review even though neither redaction pass can match the split
# value. The separator keeps the halves apart in the rendered text.
# Slurp mode: comments may span lines. An unterminated <!-- renders as
# literal text in GFM (not hidden), so it is left alone.
strip_html_comments() {
  perl -0777 -pe 's{<!--.*?-->}{ [HTML comment removed] }gs'
}

# Neutralize HTML character references (&#65;, &#x41;, &amp;, ...) by
# escaping the leading ampersand: GFM renders references as the encoded
# character, so a credential with one character entity-encoded matches
# no literal or pattern redaction yet visibly reconstructs when posted.
# Escaping the & makes the renderer show the reference literally, so
# the encoded char can never rejoin its neighbours. Applies to any
# &...; form; a bare & with no reference syntax is left alone.
neutralize_html_entities() {
  perl -0777 -pe 's{&(?=#?[A-Za-z0-9]+;)}{&amp;}g'
}

# Replace raw HTML tags with a nonempty separator: GFM renders inline
# raw HTML, so a credential split as `left<span></span>right` matches
# no redaction as halves, yet the tag syntax disappears at render and
# the posted text exposes the joined credential. The separator keeps
# the halves apart. Comments are stripped separately first; this covers
# the remaining tag and declaration forms. An unterminated < renders as
# literal text in GFM, so it is left alone.
strip_html_tags() {
  perl -0777 -pe 's{</?[A-Za-z][^>]*>|<![^>]*>}{ [HTML removed] }g'
}

# Remove ANSI terminal control sequences (CSI styling, OSC, bare ESC
# pairs): log viewers render them as styling and hide the bytes, so a
# credential split by an escape sequence displays contiguously while
# both the dynamic-key redaction and GitHub's own masker see only the
# separated halves. Deleting (not separating) lets the redaction that
# runs after this join-and-match the whole value.
strip_ansi() {
  perl -pe 's/\x1b\[[0-9;?]*[ -\/]*[@-~]//g; s/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)//g; s/\x1b.//g'
}

# Remove render-empty Markdown links: `[](dest)` and `[][ref]` render as
# an empty anchor (no visible text), so a credential split as
# `left[]()right` visibly reconstructs when posted while every redaction
# pass saw only halves. Deleting the token joins the halves where the
# redaction that runs after this can match the whole value (same
# delete-then-redact discipline as strip_images). Links with visible
# text render that text, so they are not empty and stay.
strip_empty_links() {
  perl -0777 -pe 's{\[\]\([^)]*\)}{}g; s{\[\]\[[^\]]*\]}{}g'
}

# Remove intraword Markdown formatting runs (`*`, backticks, `~~`
# flanked by word characters on both sides): GFM renders intraword
# emphasis/code/strikethrough with the markers hidden, so a credential
# split as `left*A*right` displays contiguously while every redaction
# pass saw only halves. A split needs the separator between two word
# characters (a spaced marker renders with its spaces and cannot join
# a credential), so only intraword runs go; spaced emphasis, lists,
# and snake_case are untouched. Deleting joins the halves where the
# redaction that runs after this can match the whole value.
strip_intraword_markers() {
  perl -0777 -pe 's{(?<=[A-Za-z0-9])(?:\*+|`+|~{2,})(?=[A-Za-z0-9])}{}g'
}

# Canonicalize visible Markdown links to `text (destination)`: GFM
# renders only the link text, so a credential wrapping an interior
# character as `left[A](https://example.com)right` displays as the
# joined value while every redaction pass saw the markup form. Writing
# the destination as visible text keeps citations readable (the URL is
# still shown) while the separating ` (url)` breaks contiguity. Alt
# text and destinations accept balanced nesting, mirroring
# strip_images. Reference forms keep their label the same way. Links
# with empty text are deleted earlier (strip_empty_links).
canonicalize_links() {
  perl -0777 -pe 's{\[((?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.)*\])*\])*)\]\(((?:[^()\\]++|\\.|\((?:[^()\\]++|\\.|\((?:[^()\\]++|\\.)*\))*\))*)\)}{$1 ($2)}g; s{\[((?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.)*\])*\])*)\]\[((?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.|\[(?:[^\[\]\\]++|\\.)*\])*\])*)\]}{$1 ($2)}g'
}

# Byte-bounded UTF-8-safe truncation WITH an explicit marker, reserved
# inside the budget: trunc_bytes cuts silently, so a truncated inline
# finding would read as complete while its tail exists nowhere.
trunc_bytes_marked() {
  local _bytes="$1" _tmp _marker
  _marker=$'\n\n[... truncated for length ...]'
  _tmp="$(mktemp)"
  cat > "${_tmp}"
  if (( $(wc -c < "${_tmp}") > _bytes )); then
    head -c $((_bytes - ${#_marker})) "${_tmp}" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || true
    printf '%s' "${_marker}"
  else
    cat "${_tmp}"
  fi
  rm -f "${_tmp}"
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

# Lossless single-line encoding of raw symlink-target bytes (stdin to
# stdout, no trailing newline). Backslash, LF, and CR become \\, \n, \r
# literals; bytes that are not part of a well-formed UTF-8 sequence
# become \xHH; well-formed sequences (including multibyte) pass through
# unchanged. The result is always valid UTF-8, so downstream UTF-8
# filtering cannot silently delete target bytes, and always one line,
# so trailing newlines survive as visible \n instead of being stripped
# by command-substitution captures.
escape_symlink_target() {
  perl -e '
    local $/; my $s = <STDIN>; $s = "" unless defined $s;
    my $out = ""; my $i = 0; my $n = length $s;
    while ($i < $n) {
      my $b = ord substr($s, $i, 1);
      if ($b == 92) { $out .= "\\\\"; $i++ }
      elsif ($b == 10) { $out .= "\\n"; $i++ }
      elsif ($b == 13) { $out .= "\\r"; $i++ }
      elsif ($b < 128) { $out .= substr($s, $i, 1); $i++ }
      else {
        my ($len, $lo, $hi) = (0, 128, 191);
        if ($b >= 194 && $b <= 223) { $len = 2 }
        elsif ($b == 224) { $len = 3; $lo = 160 }
        elsif ($b >= 225 && $b <= 236) { $len = 3 }
        elsif ($b == 237) { $len = 3; $hi = 159 }
        elsif ($b >= 238 && $b <= 239) { $len = 3 }
        elsif ($b == 240) { $len = 4; $lo = 144 }
        elsif ($b >= 241 && $b <= 243) { $len = 4 }
        elsif ($b == 244) { $len = 4; $hi = 143 }
        my $ok = 0;
        if ($len && $i + $len <= $n) {
          my $b2 = ord substr($s, $i + 1, 1);
          if ($b2 >= $lo && $b2 <= $hi) {
            $ok = 1;
            for (my $j = 2; $j < $len; $j++) {
              my $bj = ord substr($s, $i + $j, 1);
              if ($bj < 128 || $bj > 191) { $ok = 0; last }
            }
          }
        }
        if ($ok) { $out .= substr($s, $i, $len); $i += $len }
        else { $out .= sprintf "\\x%02X", $b; $i++ }
      }
    }
    print $out;
  '
}

# Lossless encoding of arbitrary evidence bytes (stdin to stdout):
# bytes that are not part of a well-formed UTF-8 sequence become \xHH;
# a source backslash doubles, so literal `\xFF` text can never be
# mistaken for an escaped 0xFF byte; everything else — newlines, valid
# multibyte — passes through unchanged. Unlike escape_symlink_target this preserves the
# text layout (diffs and removed-line blocks stay readable) while
# guaranteeing valid UTF-8 output, so no downstream filter needs to
# silently delete evidence bytes.
escape_invalid_utf8() {
  perl -e '
    local $/; my $s = <STDIN>; $s = "" unless defined $s;
    my $out = ""; my $i = 0; my $n = length $s;
    while ($i < $n) {
      my $b = ord substr($s, $i, 1);
      if ($b == 92) { $out .= "\\\\"; $i++ }
      elsif ($b < 128) { $out .= substr($s, $i, 1); $i++ }
      else {
        my ($len, $lo, $hi) = (0, 128, 191);
        if ($b >= 194 && $b <= 223) { $len = 2 }
        elsif ($b == 224) { $len = 3; $lo = 160 }
        elsif ($b >= 225 && $b <= 236) { $len = 3 }
        elsif ($b == 237) { $len = 3; $hi = 159 }
        elsif ($b >= 238 && $b <= 239) { $len = 3 }
        elsif ($b == 240) { $len = 4; $lo = 144 }
        elsif ($b >= 241 && $b <= 243) { $len = 4 }
        elsif ($b == 244) { $len = 4; $hi = 143 }
        my $ok = 0;
        if ($len && $i + $len <= $n) {
          my $b2 = ord substr($s, $i + 1, 1);
          if ($b2 >= $lo && $b2 <= $hi) {
            $ok = 1;
            for (my $j = 2; $j < $len; $j++) {
              my $bj = ord substr($s, $i + $j, 1);
              if ($bj < 128 || $bj > 191) { $ok = 0; last }
            }
          }
        }
        if ($ok) { $out .= substr($s, $i, $len); $i += $len }
        else { $out .= sprintf "\\x%02X", $b; $i++ }
      }
    }
    print $out;
  '
}

# True when a file (arg) or a git blob (sha, path) contains a NUL byte.
# Checked on raw bytes, never a Bash variable: command substitution
# silently drops NULs and could join otherwise separate text.
file_has_nul() {
  perl -0777 -ne 'exit(index($_, "\0") >= 0 ? 0 : 1)' -- "$1" 2>/dev/null
}
blob_has_nul() {
  git show "$1:$2" 2>/dev/null | perl -0777 -ne 'exit(index($_, "\0") >= 0 ? 0 : 1)'
}
# True only for a regular-file blob in a git tree (sha, path): a
# directory/gitlink named like a guidance file makes `git show`
# succeed with a tree/commit listing, which must not be treated as a
# readable file. Symlink blobs (120000) are likewise rejected.
base_guidance_blob() {
  local _entry
  _entry="$(git --literal-pathspecs ls-tree "$1" -- "$2" 2>/dev/null)"
  case "${_entry}" in 100644\ *|100755\ *) return 0 ;; *) return 1 ;; esac
}

# Changed-path symlink targets, one `path -> target` line per link, for the
# review input. The agent runs symlink-blind (the sweep above removes every
# workspace link before the key is exposed), the manifest records paths only,
# and a changed link's hunk can fall past the diff cap — without this, the
# run would publish success over an unseen target. Record BEFORE the sweep.
# Targets are untrusted (readlink output on submitter-controlled paths):
# raw bytes are captured to a file with `readlink -n` (no separator
# newline, no command substitution — substitution strips trailing
# newlines from the target itself and records a different link), then
# encoded with escape_symlink_target; the caller neutralizes tags and
# bounds the whole block. A target over 500 bytes returns 3 (caller
# fails closed): cutting it would hide the decisive suffix of the only
# copy the reviewer can see. Prints at most _max entries; returns 2 when
# more changed symlinks exist (caller marks PARTIAL), 1 when the
# inventory is unreadable. Absolute and ..-carrying
# paths are skipped: joined onto the root they could resolve outside the
# checkout (same containment rule as head_readable).
# Links the PR deletes (or replaces with a regular file) fail the head -L
# test, yet their base-side target is review evidence too: when _base_ref and
# _repo name the fetched base commit, mode-120000 base entries print as
# `path -> base target (base-side; deleted or replaced in head)` and count toward
# _max like head lines. Rename sources (previous_filename) get the same
# base lookup — querying the destination in the base cannot recover the
# source target — labeled `(base-side; renamed away in head)`. Empty
# ref/repo disables the base lookup (head-only); the caller labels that
# absence explicitly.
changed_symlinks() {
  local _files="$1" _root="$2" _max="${3:-50}" _base_ref="${4:-}" _repo="${5:-}" _count=0 _rec _kind _f _suffix _entry _raw _esc _label _side
  jq -e 'type == "array"' "${_files}" >/dev/null 2>&1 || return 1
  _raw="$(mktemp)" || return 1
  while IFS= read -r -d '' _rec; do
    _kind="${_rec%%$'\t'*}"
    _f="${_rec#*$'\t'}"
    case "${_f}" in /*|..|../*|*/../*|*/..) continue ;; esac
    : > "${_raw}"
    if [[ "${_kind}" == "F" && -L "${_root}/${_f}" ]]; then
      readlink -n -- "${_root}/${_f}" > "${_raw}" 2>/dev/null || : > "${_raw}"
      _suffix=""
      _side="head"
    else
      _side="base"
      if [[ "${_kind}" == "P" ]]; then
        _suffix=" (base-side; renamed away in head)"
      else
        _suffix=" (base-side; deleted or replaced in head)"
      fi
      if [[ -n "${_base_ref}" && -n "${_repo}" ]]; then
        # --literal-pathspecs: _f is an untrusted PR filename. Read as a
        # pathspec, magic names (e.g. a file named ':(glob)*') make
        # ls-tree error out; swallowed by || true, the base-side target
        # would be silently omitted and the review would post success
        # over unseen evidence. Literal mode matches the name as-is.
        _entry="$(git --literal-pathspecs -C "${_repo}" ls-tree "${_base_ref}" -- "${_f}" 2>/dev/null || true)"
        if [[ "${_entry}" == 120000[[:space:]]* ]]; then
          git -C "${_repo}" show "${_base_ref}:${_f}" > "${_raw}" 2>/dev/null || : > "${_raw}"
        fi
      fi
      [[ -s "${_raw}" ]] || continue
    fi
    _count=$((_count + 1))
    if (( _count > _max )); then rm -f "${_raw}"; return 2; fi
    if (( $(wc -c < "${_raw}") > 500 )); then rm -f "${_raw}"; return 3; fi
    _esc="$(escape_symlink_target < "${_raw}")"
    # Escape backslashes BEFORE newlines (as manifest_paths does), so a
    # literal `a\nb` path and an actual-newline `a<LF>b` path do not
    # render with the identical label and swap targets in the prompt.
    _label="${_f//\\/\\\\}"
    _label="${_label//$'\n'/\\n}"
    _label="${_label//$'\r'/\\r}"
    _label="${_label// -> / -\\> }"
    # Side is an explicit field BEFORE the target (as in
    # changed_gitlinks): a target literally ending in the base-side
    # annotation text can no longer impersonate a base record.
    printf '%s -> %s %s%s\n' "${_label}" "${_side}" "${_esc}" "${_suffix}"
  done < <(jq -j '[.[] | {f: (.filename // empty), p: (.previous_filename // "")} | select(.f | type == "string") | ("F\t" + .f), (if (.p | type) == "string" and (.p | length) > 0 and .p != .f then ("P\t" + .p) else empty end)] | .[] + "\u0000"' "${_files}" 2>/dev/null)
  rm -f "${_raw}"
}

# Changed gitlink targets, one `path -> head|base <oid>` line per side.
# Submodules are never populated by checkout, so a changed gitlink's
# head OID lives only in its diff hunk — past the 60 KB diff cap the
# manifest (paths only) and removed-lines supplement (old OID only,
# or nothing for a new link) leave the reviewer no way to determine
# the target yet able to publish success. Record OIDs from the tree
# objects (ls-tree on the captured SHAs), like symlink targets, so
# the evidence survives truncation; caller fails closed past caps.
# Returns 1 when inventory unreadable, 2 when more than _max lines.
changed_gitlinks() {
  local _files="$1" _head_ref="$2" _base_ref="$3" _repo="$4" _max="${5:-50}" _count=0 _rec _kind _f _entry _rest _head_oid _base_oid _label _suffix
  jq -e 'type == "array"' "${_files}" >/dev/null 2>&1 || return 1
  while IFS= read -r -d '' _rec; do
    _kind="${_rec%%$'\t'*}"
    _f="${_rec#*$'\t'}"
    case "${_f}" in /*|..|../*|*/../*|*/..) continue ;; esac
    _head_oid=""
    _base_oid=""
    if [[ "${_kind}" == "F" && -n "${_head_ref}" && -n "${_repo}" ]]; then
      _entry="$(git --literal-pathspecs -C "${_repo}" ls-tree "${_head_ref}" -- "${_f}" 2>/dev/null || true)"
      if [[ "${_entry}" == 160000\ * ]]; then
        _rest="${_entry#* }"; _rest="${_rest#* }"; _head_oid="${_rest%%$'\t'*}"
      fi
    fi
    if [[ -n "${_base_ref}" && -n "${_repo}" ]]; then
      _entry="$(git --literal-pathspecs -C "${_repo}" ls-tree "${_base_ref}" -- "${_f}" 2>/dev/null || true)"
      if [[ "${_entry}" == 160000\ * ]]; then
        _rest="${_entry#* }"; _rest="${_rest#* }"; _base_oid="${_rest%%$'\t'*}"
      fi
    fi
    _label="${_f//\\/\\\\}"
    _label="${_label//$'\n'/\\n}"
    _label="${_label//$'\r'/\\r}"
    _label="${_label// -> / -\\> }"
    if [[ -n "${_base_oid}" && "${_base_oid}" != "${_head_oid}" ]]; then
      if [[ "${_kind}" == "P" ]]; then
        _suffix=" (base-side; renamed away in head)"
      elif [[ -z "${_head_oid}" ]]; then
        _suffix=" (base-side; deleted or replaced in head)"
      else
        _suffix=" (base-side; previous gitlink target)"
      fi
      _count=$((_count + 1))
      if (( _count > _max )); then return 2; fi
      printf '%s -> base %s%s\n' "${_label}" "${_base_oid}" "${_suffix}"
    fi
    if [[ -n "${_head_oid}" ]]; then
      _count=$((_count + 1))
      if (( _count > _max )); then return 2; fi
      printf '%s -> head %s\n' "${_label}" "${_head_oid}"
    fi
  done < <(jq -j '[.[] | {f: (.filename // empty), p: (.previous_filename // "")} | select(.f | type == "string") | ("F\t" + .f), (if (.p | type) == "string" and (.p | length) > 0 and .p != .f then ("P\t" + .p) else empty end)] | .[] + "\u0000"' "${_files}" 2>/dev/null)
}

# Changed file modes, one `path: base <mode>, head <mode>` line per
# file whose tree mode differs (including new/deleted files, where
# one side is absent). A mode-only change (executable bit) has no
# content hunk: past the 60 KB diff cap its `old mode`/`new mode`
# records are truncated, the removed-lines supplement excludes mode
# headers, the manifest records only paths, and reading the head file
# cannot reveal the base mode. Record modes from the captured tree
# objects like gitlink targets, so the evidence survives truncation;
# caller fails closed past caps. Returns 1 unreadable, 2 over _max.
changed_modes() {
  local _files="$1" _head_ref="$2" _base_ref="$3" _repo="$4" _max="${5:-50}" _count=0 _f _prev _base_path _hentry _bentry _hmode _bmode _label
  jq -e 'type == "array"' "${_files}" >/dev/null 2>&1 || return 1
  # Fields arrive as separate NUL-terminated values (filename, then
  # previous_filename): joining them with a tab made a filename
  # containing a literal tab truncate at its first tab and leak the
  # remainder into the previous-path field.
  while IFS= read -r -d '' _f; do
    if ! IFS= read -r -d '' _prev; then _prev=""; fi
    case "${_f}" in /*|..|../*|*/../*|*/..) continue ;; esac
    _base_path="${_f}"
    if [[ -n "${_prev}" && "${_prev}" != "${_f}" ]]; then _base_path="${_prev}"; fi
    _hmode=""
    _bmode=""
    if [[ -n "${_head_ref}" && -n "${_repo}" ]]; then
      _hentry="$(git --literal-pathspecs -C "${_repo}" ls-tree "${_head_ref}" -- "${_f}" 2>/dev/null || true)"
      if [[ -n "${_hentry}" ]]; then _hmode="${_hentry%%[[:space:]]*}"; fi
    fi
    if [[ -n "${_base_ref}" && -n "${_repo}" ]]; then
      _bentry="$(git --literal-pathspecs -C "${_repo}" ls-tree "${_base_ref}" -- "${_base_path}" 2>/dev/null || true)"
      if [[ -n "${_bentry}" ]]; then _bmode="${_bentry%%[[:space:]]*}"; fi
    fi
    if [[ "${_hmode}" == "${_bmode}" ]]; then continue; fi
    if [[ -z "${_hmode}" && -z "${_bmode}" ]]; then continue; fi
    _label="${_f//\\/\\\\}"
    _label="${_label//$'\n'/\\n}"
    _label="${_label//$'\r'/\\r}"
    _label="${_label// -> / -\\> }"
    _count=$((_count + 1))
    if (( _count > _max )); then return 2; fi
    if [[ -n "${_bmode}" && -n "${_hmode}" ]]; then
      printf '%s: base %s, head %s\n' "${_label}" "${_bmode}" "${_hmode}"
    elif [[ -n "${_hmode}" ]]; then
      printf '%s: head %s (new file)\n' "${_label}" "${_hmode}"
    else
      printf '%s: base %s (deleted)\n' "${_label}" "${_bmode}"
    fi
  done < <(jq -j '.[] | select((.filename | type) == "string") | .filename, (if (.previous_filename | type) == "string" then .previous_filename else "" end) | . + "\u0000"' "${_files}" 2>/dev/null)
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
  # CRs are removed before matching in this same pass, so a key split
  # by a raw CR (or a decoded \u000d) joins while the key is available
  # and redacts instead of rejoining later when a downstream filter
  # deletes CRs (the same rejoin class as NUL/image splits).
  printf '%s' "$1" | META_API_KEY="${META_API_KEY:-}" perl -0777 -pe 'BEGIN { $k = $ENV{META_API_KEY} // q{} } s/\r//g; if (length $k) { $q = quotemeta($k); s/$q/[REDACTED]/g } s/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/[REDACTED-PRIVATE-KEY]/gs; s/\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[A-Za-z]-|AKIA)[A-Za-z0-9_\-]+/[REDACTED]/g; s/\bAIza[0-9A-Za-z_\-]{35}/[REDACTED]/g; s/eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+/[REDACTED-JWT]/g; s/((?:api[_-]?key|secret|token|password)\s*[:=]\s*["'"'"']?)[A-Za-z0-9_\-.\/+]{12,}/${1}[REDACTED]/gi'
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
# Nested escaping (JSON inside a JSON string) hides the key one level
# deeper: the parsed value still carries \uXXXX text that a downstream
# decode revives. So each backslash-bearing string is also repeatedly
# JSON-unescaped to a fixed point (every changing pass strictly
# shortens the string, so an input-length bound always suffices; no
# fixed pass limit for nesting depth to exceed) and replaced ONLY when
# the decoded form actually contains the key — key-free strings keep
# exact original bytes. Unescaping is a manual codepoint state machine, not a
# quote-wrap reparse: values containing raw quotes or control chars
# (common in finding bodies) cannot reparse as bare JSON string
# content, and a reparse-or-keep fallback would skip decoding exactly
# the hostile strings. Malformed/truncated escapes pass through
# literally; any hard failure keeps the original string.
# Image markup is stripped for a second containment form: the post
# step deletes image tokens (strip_images) AFTER its redaction pass, so
# a key split by a removable token (key-half![](url)key-half) would
# rejoin there exactly like the NUL case. Checking the image-stripped
# form here, while the key is available, and emitting that form when it
# matches keeps every byte-removing filter ahead of the last redaction.
# NUL bytes are normalized away BEFORE any containment check: a key
# split by an embedded U+0000 is not contiguous here, but the keyless
# post step extracts decoded strings with `jq -r` into Bash variables,
# Bash silently discards NUL bytes, and the halves rejoin into the live
# credential where only pattern redaction remains. Stripping NULs while
# the key is still available makes a split key contiguous (and therefore
# redactable) and guarantees no NUL reaches the post step; the decoded
# form of backslash-bearing strings is stripped the same way, since a
# `\u0000` escape sequence decodes to the same byte one level down.
# CR bytes are stripped the same way: a downstream CR-deleting filter
# (neutralize_workflow_commands in the log path) would otherwise join
# a CR-split key after this pass.
redact_json_key() {
  local _key="${META_API_KEY:-}"
  [[ -n "${_key}" ]] || return 1
  jq --arg k "${_key}" '
    def _hexval:
      if . >= 48 and . <= 57 then . - 48
      elif . >= 97 and . <= 102 then . - 87
      elif . >= 65 and . <= 70 then . - 55
      else -1 end;
    def _unesc1:
      (explode) as $cs
      | (reduce $cs[] as $c ({out: [], mode: 0, hex: []};
          if .mode == 0 then
            if $c == 92 then .mode = 1 else .out += [$c] end
          elif .mode == 1 then
            if $c == 117 then .mode = 2 | .hex = []
            elif $c == 47 then .out += [47] | .mode = 0
            elif $c == 92 then .out += [92] | .mode = 0
            elif $c == 34 then .out += [34] | .mode = 0
            elif $c == 110 then .out += [10] | .mode = 0
            elif $c == 114 then .out += [13] | .mode = 0
            elif $c == 116 then .out += [9] | .mode = 0
            elif $c == 98 then .out += [8] | .mode = 0
            elif $c == 102 then .out += [12] | .mode = 0
            else .out += [92, $c] | .mode = 0 end
          else
            .hex += [$c]
            | if (.hex | length) < 4 then .
              else
                (if (.hex | all(_hexval >= 0))
                 then .out += [(.hex | map(_hexval) | reduce .[] as $d (0; . * 16 + $d))]
                 else .out += ([92, 117] + .hex) end)
                | .mode = 0 | .hex = []
              end
          end)) as $st
      | (($st.out
          + (if $st.mode == 1 then [92]
             elif $st.mode == 2 then [92, 117] + $st.hex
             else [] end)) | implode);
    def _unesc: (. as $s | try _unesc1 catch $s);
    def _deep:
      (. as $orig
       | {s: ., done: false}
       | reduce range(0; ($orig | length) + 1) as $i (.;
           if .done then .
           else ((.s | _unesc) as $u
                 | if $u == .s then .done = true else .s = $u end)
           end)
       | .s);
    def _denul: split("\u0000") | join("");
    def _decr: split("\r") | join("");
    def _img1: gsub("!\\[[^\\]]*\\]\\([^)]*\\)"; "") | gsub("</?(img|IMG)[^>]*>"; "");
    def _imgstrip: (_img1 as $once | if $once == . then . else ($once | _imgstrip) end);
    walk(if type == "string" then
      ((. | _denul | _decr) as $s
       | if ($s | contains($k)) then ($s | split($k) | join("[REDACTED]"))
         elif (($s | _imgstrip) | contains($k)) then (($s | _imgstrip) | split($k) | join("[REDACTED]"))
         elif ($s | contains("\\")) then
           ((($s | _deep) | _denul | _decr) as $dec
            | if ($dec | contains($k)) then ($dec | split($k) | join("[REDACTED]"))
              elif (($dec | _imgstrip) | contains($k)) then (($dec | _imgstrip) | split($k) | join("[REDACTED]"))
              else $s end)
         else $s end)
    else . end)'
}

# Decode JSON escape sequences in possibly-mixed text (stdin to stdout).
# redact_json_key needs the WHOLE input to be one valid JSON value, so prose
# around a JSON fragment (e.g. `error: {"key":"live\/key\u003dabc"}`) fails
# the parse and byte redaction then misses the reversible escaped key. Run
# this before redact() on the non-JSON path so escaped bytes match too.
# Bounded fixed point, NOT single-pass: JSON nested inside another JSON
# string (or quoted in prose) doubly escapes the key (`\\u002f`), and one
# decode level — or a lookbehind sparing escaped backslashes — leaves it
# reversible in the log/post. Each pass collapses \\ first (one nesting
# level), then decodes \uXXXX and \/; every changing pass strictly
# shortens the text and at least halves any backslash run, so the loop
# reaches its fixed point long before the pass cap (64 halvings exceed
# any backslash run a real input can contain). Aggressive by design:
# any over-decoding only over-redacts, never leaks.
decode_json_escapes() {
  perl -pe '$c = 0; while ($c++ < 64) { $p = $_; s/\\\\/\\/g; s/\\u([0-9a-fA-F]{4})/chr(hex($1))/ge; s/\\\//\//g; last if $_ eq $p; }'
}

# Neutralize Actions workflow commands in untrusted log text (stdin to
# stdout). The runner executes any log line starting with `::` as a command
# (annotations, masks, groups); decoded model stderr can smuggle one via
# `\u000a\u003a...` escapes, and GitHub offers no command escaping — so break
# the prefix with a space. CRs become a space first (a nonempty
# separator, not deletion): `\r::cmd` must not survive the anchor, and
# deleting a CR between key halves would rejoin a split credential.
neutralize_workflow_commands() {
  perl -pe 's/\r/ /g; s/^::/ ::/'
}

# Changed-path manifest lines from a PR-files JSON array: one escaped path
# per line. Backslashes escape FIRST, then newlines — escaping newlines
# alone maps `a<LF>b` and a literal `a\nb` to the same bytes, so the
# shell-disabled reviewer could miss a file it cannot re-derive. Mirrors
# jq @tsv (which the changed-files summary already relies on). Renames
# render as `old -> new`: past the summary/diff/supplement caps the
# manifest is the only complete record, and without the source path the
# reviewer cannot discover that the old path was removed. A literal
# ` -> ` inside a filename escapes to ` -\> `, so the rename delimiter
# is the only unescaped ` -> ` on a line and an ordinary file named
# `a -> b` cannot be mistaken for a rename from `a` to `b`.
manifest_paths() {
  jq -r 'def esc: gsub("\\\\"; "\\\\") | gsub("\n"; "\\n") | gsub(" -> "; " -\\> ");
    .[] | (.previous_filename // "") as $prev
    | if ($prev | length) > 0 then "\($prev | esc) -> \(.filename | esc)"
      else (.filename | esc) end' "$1" 2>/dev/null
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
