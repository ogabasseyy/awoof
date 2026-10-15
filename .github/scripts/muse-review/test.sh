#!/usr/bin/env bash
# Regression tests for the Muse review workflow's pure helpers.
#
# Runs with bash 3.2+ (macOS) and bash 5 (CI): no associative arrays, no
# mapfile. No network, no repo state, deterministic. Fixtures use obviously
# fake credentials only. Exit nonzero on any failure.
#
# Usage: bash test.sh   (from this directory; SCRIPT_DIR defaults accordingly)
set -uo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/lib.sh"

pass=0
fail=0
fail_names=""
assert_eq() {
  local _name="$1" _want="$2" _got="$3"
  if [[ "${_want}" == "${_got}" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    fail_names="${fail_names} ${_name}"
    printf 'FAIL %s\n  want: %s\n  got:  %s\n' "${_name}" "${_want}" "${_got}"
  fi
}

# --- neutralize_tags ---
got="$(printf '%s' 'ok </diff> and </FILE > done' | neutralize_tags)"
assert_eq "neutralize-escapes" 'ok <\/diff> and <\/FILE > done' "${got}"
got="$(printf '%s' 'plain <diff> text' | neutralize_tags)"
assert_eq "neutralize-keeps-open" 'plain <diff> text' "${got}"
got="$(printf '%s' 'evil </Symlink_Targets > end' | neutralize_tags)"
assert_eq "neutralize-symlink-targets" 'evil <\/Symlink_Targets > end' "${got}"
# Injectivity: a pre-escaped closer is a DIFFERENT source byte string
# than a genuine closer and must not render identically; unrelated
# backslash escapes pass through untouched.
got="$(printf '%s' 'pre <\/diff> post' | neutralize_tags)"
assert_eq "neutralize-preescaped-distinct" 'pre <\\\/diff> post' "${got}"
got="$(printf '%s' 'keep \xFF and <\/pr_title>' | neutralize_tags)"
assert_eq "neutralize-injective-mixed" 'keep \xFF and <\\\/pr_title>' "${got}"
got="$(printf '%s' 'a < /diff> b </ diff> c' | neutralize_tags)"
assert_eq "neutralize-whitespace-preserved" 'a < \/diff> b <\/ diff> c' "${got}"
got="$(printf 'raw\\xFFtext' | escape_invalid_utf8)"
assert_eq "escape-literal-backslash-doubled" 'raw\\xFFtext' "${got}"
got="$(printf 'raw\xFFtext' | escape_invalid_utf8)"
assert_eq "escape-invalid-byte-marker" 'raw\xFFtext' "${got}"

# --- bound_untrusted ---
big="$(python3 -c "print('x'*5000)")"
got="$(bound_untrusted "${big}" 2000)"
assert_eq "bound-ascii-bytes" "2034" "$(printf '%s' "${got}" | wc -c | tr -d ' ')"
case "${got}" in *"[... truncated at 2000 bytes ...]"*) got_marker="yes";; *) got_marker="no";; esac
assert_eq "bound-ascii-marker" "yes" "${got_marker}"
mb="$(python3 -c "print('é'*2000)")"
got="$(bound_untrusted "${mb}" 2000)"
if printf '%s' "${got}" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then got_valid="yes"; else got_valid="no"; fi
assert_eq "bound-multibyte-valid" "yes" "${got_valid}"
assert_eq "bound-multibyte-bytes" "2034" "$(printf '%s' "${got}" | wc -c | tr -d ' ')"
assert_eq "bound-under-cap" "hello" "$(bound_untrusted "hello" 2000)"

# --- trunc_bytes ---
got="$(printf 'abcdef' | trunc_bytes 4)"
assert_eq "trunc-basic" "abcd" "${got}"
got="$(printf 'éééé' | trunc_bytes 5)"
assert_eq "trunc-multibyte-safe" "éé" "${got}"

# --- cap_file ---
t1="$(mktemp)"; printf '0123456789' > "${t1}"
cap_file "${t1}" 4
assert_eq "capfile-cuts" "0123" "$(cat "${t1}")"
t2="$(mktemp)"; printf 'abc' > "${t2}"
cap_file "${t2}" 4
assert_eq "capfile-keeps" "abc" "$(cat "${t2}")"
rm -f "${t1}" "${t2}"
if cap_file "/nonexistent-muse-test-$$" 4 2>/dev/null; then got_rc=0; else got_rc=1; fi
assert_eq "capfile-missing-rc" "1" "${got_rc}"

# --- sanitize_mentions ---
zwsp=$'\xe2\x80\x8b'
got="$(printf '%s' 'hi @octocat, ping @a-b and mail a@b.com' | sanitize_mentions)"
assert_eq "mentions-zwsp" "hi @${zwsp}octocat, ping @${zwsp}a-b and mail a@b.com" "${got}"
got="$(printf '%s' 'see https://www.npmjs.com/package/@scope/pkg and ping @user' | sanitize_mentions)"
assert_eq "mentions-url-kept" "see https://www.npmjs.com/package/@scope/pkg and ping @${zwsp}user" "${got}"
got="$(printf '%s' '@lead starts here' | sanitize_mentions)"
assert_eq "mentions-start" "@${zwsp}lead starts here" "${got}"
got="$(printf '%s' 'say (@octo) and "[@root]" ok' | sanitize_mentions)"
assert_eq "mentions-bracket-quote" "say (@${zwsp}octo) and \"[@${zwsp}root]\" ok" "${got}"
got="$(printf '%s' 'mail,@a cc:@b path/@c `{@d}` ;@e' | sanitize_mentions)"
assert_eq "mentions-punct" "mail,@${zwsp}a cc:@${zwsp}b path/@${zwsp}c \`{@${zwsp}d}\` ;@${zwsp}e" "${got}"
got="$(printf '%s' '@@double hunk @@ -1 +1 @@' | sanitize_mentions)"
assert_eq "mentions-adjacent" "@@${zwsp}double hunk @@ -1 +1 @@" "${got}"

# --- head_readable ---
linkdir="$(mktemp -d)"
mkdir -p "${linkdir}/real" && printf 'x' > "${linkdir}/real/AGENTS.md"
ln -s /etc "${linkdir}/farm"
ln -s "${linkdir}/real/AGENTS.md" "${linkdir}/filelink"
if (cd "${linkdir}" && head_readable "real/AGENTS.md"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-regular" "yes" "${got_hr}"
if (cd "${linkdir}" && head_readable "farm/AGENTS.md"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-symlinked-parent" "no" "${got_hr}"
if (cd "${linkdir}" && head_readable "filelink"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-symlinked-file" "no" "${got_hr}"
if (cd "${linkdir}" && head_readable "missing/AGENTS.md"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-missing" "no" "${got_hr}"
if (cd "${linkdir}" && head_readable "real/../real/AGENTS.md"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-dotdot" "no" "${got_hr}"
if (cd "${linkdir}" && head_readable "${linkdir}/real/AGENTS.md"); then got_hr="yes"; else got_hr="no"; fi
assert_eq "readable-absolute" "no" "${got_hr}"
rm -rf "${linkdir}"

# --- sweep_workspace_symlinks ---
sweepdir="$(mktemp -d)"
mkdir -p "${sweepdir}/.git" "${sweepdir}/trusted-scripts" "${sweepdir}/sub"
printf 'x' > "${sweepdir}/real.txt"
ln -s /etc "${sweepdir}/leak.txt"
ln -s /tmp "${sweepdir}/sub/dirlink"
ln -s /etc/hostname "${sweepdir}/.git/keeper"
ln -s /etc/hostname "${sweepdir}/trusted-scripts/planted"
got="$(sweep_workspace_symlinks "${sweepdir}")"
assert_eq "sweep-count" "3" "${got}"
if [[ -L "${sweepdir}/leak.txt" || -L "${sweepdir}/sub/dirlink" || -L "${sweepdir}/trusted-scripts/planted" ]]; then got_left="yes"; else got_left="no"; fi
assert_eq "sweep-removed" "no" "${got_left}"
# Only .git is pruned: trusted helpers stage outside the reviewed
# workspace, so a PR-tracked trusted-scripts/ subtree is untrusted and
# swept like everything else.
if [[ -L "${sweepdir}/.git/keeper" && -f "${sweepdir}/real.txt" ]]; then got_kept="yes"; else got_kept="no"; fi
assert_eq "sweep-prunes" "yes" "${got_kept}"
rm -rf "${sweepdir}"

# --- changed_symlinks ---
symdir="$(mktemp -d)"
mkdir -p "${symdir}/ws/sub"
printf 'x' > "${symdir}/ws/real.txt"
ln -s /etc "${symdir}/ws/leak.txt"
ln -s ../real.txt "${symdir}/ws/sub/rel"
ln -s /etc/hostname "${symdir}/ws/untracked-link"
ln -s "${symdir}/ws/real.txt" "${symdir}/escape"
printf '[{"filename":"leak.txt"},{"filename":"sub/rel"},{"filename":"real.txt"},{"filename":"missing.txt"}]' > "${symdir}/files.json"
got="$(changed_symlinks "${symdir}/files.json" "${symdir}/ws" 50)"
assert_eq "symlinks-targets" "$(printf 'leak.txt -> head /etc\nsub/rel -> head ../real.txt')" "${got}"
got="$(changed_symlinks "${symdir}/files.json" "${symdir}/ws" 1 2>/dev/null)"; got_rc=$?
assert_eq "symlinks-overcap-first" "leak.txt -> head /etc" "${got}"
assert_eq "symlinks-overcap-rc" "2" "${got_rc}"
if changed_symlinks "/nonexistent-muse-test-$$" "${symdir}/ws" >/dev/null 2>&1; then got_rc=0; else got_rc=$?; fi
assert_eq "symlinks-missing-rc" "1" "${got_rc}"
printf 'not json' > "${symdir}/bad.json"
if changed_symlinks "${symdir}/bad.json" "${symdir}/ws" >/dev/null 2>&1; then got_rc=0; else got_rc=$?; fi
assert_eq "symlinks-corrupt-rc" "1" "${got_rc}"
printf '[{"filename":"../escape"},{"filename":"/etc/hostname"}]' > "${symdir}/evil.json"
got="$(changed_symlinks "${symdir}/evil.json" "${symdir}/ws" 50)"
assert_eq "symlinks-skips-escape" "" "${got}"
ln -s "$(printf 'a\nb')" "${symdir}/ws/nl.txt"
printf '[{"filename":"nl.txt"}]' > "${symdir}/nlf.json"
got="$(changed_symlinks "${symdir}/nlf.json" "${symdir}/ws" 50)"
assert_eq "symlinks-flattens-newline" 'nl.txt -> head a\nb' "${got}"
longt="$(python3 -c "print('t'*600)")"
ln -s "${longt}" "${symdir}/ws/long.txt"
printf '[{"filename":"long.txt"}]' > "${symdir}/longf.json"
got="$(changed_symlinks "${symdir}/longf.json" "${symdir}/ws" 50 2>/dev/null)"; got_rc=$?
assert_eq "symlinks-target-cap-rc" "3" "${got_rc}"
assert_eq "symlinks-target-cap-empty" "" "${got}"
# Lossless capture: trailing newlines are part of the target, so they must
# survive as visible \n (command substitution used to strip them and
# record a different link); invalid UTF-8 bytes must survive as \xHH
# (the prompt iconv used to delete them); backslashes escape so a literal
# backslash cannot masquerade as an escaped newline.
python3 -c "import os; os.symlink('target' + chr(10) + chr(10), '${symdir}/ws/trail')"
printf '[{"filename":"trail"}]' > "${symdir}/tlf.json"
got="$(changed_symlinks "${symdir}/tlf.json" "${symdir}/ws" 50)"
assert_eq "symlinks-trailing-newlines-kept" 'trail -> head target\n\n' "${got}"
python3 -c "import os; os.symlink(b'bad' + bytes([255]) + b'target', b'${symdir}/ws/badutf')"
printf '[{"filename":"badutf"}]' > "${symdir}/badf.json"
got="$(changed_symlinks "${symdir}/badf.json" "${symdir}/ws" 50)"
assert_eq "symlinks-invalid-utf8-escaped" 'badutf -> head bad\xFFtarget' "${got}"
python3 -c "import os; os.symlink('a' + chr(92) + 'nb', '${symdir}/ws/bslash')"
printf '[{"filename":"bslash"}]' > "${symdir}/bsf.json"
got="$(changed_symlinks "${symdir}/bsf.json" "${symdir}/ws" 50)"
assert_eq "symlinks-backslash-escaped" 'bslash -> head a\\nb' "${got}"
python3 -c "import os, json; os.symlink('/target-bs', '${symdir}/ws/' + 'a' + chr(92) + 'nb'); os.symlink('/target-nl', '${symdir}/ws/' + 'a' + chr(10) + 'b'); json.dump([{'filename': 'a' + chr(92) + 'nb'}, {'filename': 'a' + chr(10) + 'b'}], open('${symdir}/lbl.json', 'w'))"
got="$(changed_symlinks "${symdir}/lbl.json" "${symdir}/ws" 50)"
assert_eq "symlinks-label-backslash-vs-newline" "$(printf 'a\\\\nb -> head /target-bs\na\\nb -> head /target-nl')" "${got}"
got="$(printf 'caf\xc3\xa9' | escape_symlink_target)"
assert_eq "escape-keeps-valid-multibyte" "café" "${got}"
got="$(printf 'a\xffb' | escape_symlink_target)"
assert_eq "escape-invalid-byte" 'a\xFFb' "${got}"
got="$(printf 'a\xffb\ncaf\xc3\xa9\n' | escape_invalid_utf8)"
assert_eq "evidence-escape-invalid" "$(printf 'a\\xFFb\ncafé')" "${got}"
got="$(printf 'keep\\path\n' | escape_invalid_utf8)"
assert_eq "evidence-escape-doubles-backslash" 'keep\\path' "${got}"
rm -rf "${symdir}"

# --- changed_symlinks return-2 capture under set -e (prompt.sh idiom) ---
# The bare `x="$(...)"; rc=$?` form exits the shell on the intentional
# return-2 before `$?` is read; the if/else form must survive and keep
# the first-50 lines for the PARTIAL branch.
capdir="$(mktemp -d)"
mkdir -p "${capdir}/ws"
i=0
while (( i < 55 )); do
  ln -s "/target${i}" "${capdir}/ws/link${i}"
  i=$(( i + 1 ))
done
python3 -c "import json; print(json.dumps([{'filename': 'link%d' % i} for i in range(55)]))" > "${capdir}/files.json"
got="$(set -e; if cap_lines="$(changed_symlinks "${capdir}/files.json" "${capdir}/ws" 50 2>/dev/null)"; then cap_rc=0; else cap_rc=$?; fi; printf 'rc=%s first=%s last=%s' "${cap_rc}" "$(printf '%s' "${cap_lines}" | head -n 1)" "$(printf '%s' "${cap_lines}" | tail -n 1)")"
assert_eq "capture-rc2-partial" "rc=2 first=link0 -> head /target0 last=link49 -> head /target49" "${got}"
rm -rf "${capdir}"

# --- changed_symlinks base-side targets (deleted/replaced links) ---
# A PR that deletes a symlink or replaces it with a regular file fails the
# head -L test; the base-side target must still print when the fetched base
# commit is given, or the review posts success over unseen evidence.
basedir="$(mktemp -d)"
mkdir -p "${basedir}/repo"
git -C "${basedir}/repo" init -q 2>/dev/null
printf 'x' > "${basedir}/repo/keep.txt"
ln -s /etc/target "${basedir}/repo/gone.txt"
ln -s /etc/old "${basedir}/repo/replaced.txt"
ln -s /etc/still "${basedir}/repo/still.txt"
# Pathspec-magic filename: without --literal-pathspecs the base-side
# ls-tree lookup errors on ':(glob)*' and the target is silently dropped.
ln -s /etc/magic "${basedir}/repo/:(glob)*"
ln -s /etc/before "${basedir}/repo/oldlink.txt"
git -C "${basedir}/repo" add -A 2>/dev/null
git -C "${basedir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
base_sha="$(git -C "${basedir}/repo" rev-parse HEAD 2>/dev/null)"
rm "${basedir}/repo/gone.txt"
rm "${basedir}/repo/replaced.txt" && printf 'now a file' > "${basedir}/repo/replaced.txt"
rm "${basedir}/repo/:(glob)*"
rm "${basedir}/repo/oldlink.txt" && ln -s /etc/after "${basedir}/repo/newlink.txt"
printf '[{"filename":"gone.txt"},{"filename":"replaced.txt"},{"filename":":(glob)*"},{"filename":"still.txt"},{"filename":"keep.txt"},{"filename":"newlink.txt","previous_filename":"oldlink.txt"}]' > "${basedir}/files.json"
got="$(changed_symlinks "${basedir}/files.json" "${basedir}/repo" 50 "${base_sha}" "${basedir}/repo")"
assert_eq "symlinks-base-side" "$(printf 'gone.txt -> base /etc/target (base-side; deleted or replaced in head)\nreplaced.txt -> base /etc/old (base-side; deleted or replaced in head)\n:(glob)* -> base /etc/magic (base-side; deleted or replaced in head)\nstill.txt -> head /etc/still\nnewlink.txt -> head /etc/after\noldlink.txt -> base /etc/before (base-side; renamed away in head)')" "${got}"
got="$(changed_symlinks "${basedir}/files.json" "${basedir}/repo" 50 "" "")"
assert_eq "symlinks-no-base-head-only" "$(printf 'still.txt -> head /etc/still\nnewlink.txt -> head /etc/after')" "${got}"
got="$(changed_symlinks "${basedir}/files.json" "${basedir}/repo" 50 "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" "${basedir}/repo" 2>/dev/null)"
assert_eq "symlinks-bad-ref-head-only" "$(printf 'still.txt -> head /etc/still\nnewlink.txt -> head /etc/after')" "${got}"
got="$(changed_symlinks "${basedir}/files.json" "${basedir}/repo" 1 "${base_sha}" "${basedir}/repo" 2>/dev/null)"; got_rc=$?
assert_eq "symlinks-base-counts-cap" "gone.txt -> base /etc/target (base-side; deleted or replaced in head)" "${got}"
assert_eq "symlinks-base-cap-rc" "2" "${got_rc}"
rm -rf "${basedir}"

# Base-side capture is lossless too: the blob bytes are the exact target,
# so a deleted link whose target ended in newlines records them all.
bsdir="$(mktemp -d)"
mkdir -p "${bsdir}/repo"
git -C "${bsdir}/repo" init -q 2>/dev/null
python3 -c "import os; os.symlink('gone' + chr(10), '${bsdir}/repo/gone-nl.txt')"
git -C "${bsdir}/repo" add -A 2>/dev/null
git -C "${bsdir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
bs_sha="$(git -C "${bsdir}/repo" rev-parse HEAD 2>/dev/null)"
rm "${bsdir}/repo/gone-nl.txt"
printf '[{"filename":"gone-nl.txt"}]' > "${bsdir}/files.json"
got="$(changed_symlinks "${bsdir}/files.json" "${bsdir}/repo" 50 "${bs_sha}" "${bsdir}/repo")"
assert_eq "symlinks-base-trailing-newline" 'gone-nl.txt -> base gone\n (base-side; deleted or replaced in head)' "${got}"
rm -rf "${bsdir}"

# Side is a field BEFORE the target: a head target literally ending in
# the base-side annotation text cannot impersonate a base record.
spoofdir="$(mktemp -d)"
mkdir -p "${spoofdir}/ws"
ln -s 'x (base-side; deleted or replaced in head)' "${spoofdir}/ws/spoof.txt"
printf '[{"filename":"spoof.txt"}]' > "${spoofdir}/files.json"
got="$(changed_symlinks "${spoofdir}/files.json" "${spoofdir}/ws" 50)"
assert_eq "symlinks-side-before-target" 'spoof.txt -> head x (base-side; deleted or replaced in head)' "${got}"
rm -rf "${spoofdir}"

# --- redact ---
pem='-----BEGIN TEST PRIVATE KEY-----FAKEFAKEFAKE-----END TEST PRIVATE KEY-----'
assert_eq "redact-pem" "[REDACTED-PRIVATE-KEY]" "$(redact "a ${pem} b" | sed 's/^a //; s/ b$//')"
assert_eq "redact-ghp" "[REDACTED]" "$(redact 'key ghp_abc123 rest' | awk '{print $2}')"
assert_eq "redact-akid" "[REDACTED]" "$(redact 'x AKIAIOSFODNN7EXAMPLE y' | awk '{print $2}')"
assert_eq "redact-ghs" "[REDACTED]" "$(redact 'tok ghs_faketoken1 y' | awk '{print $2}')"
assert_eq "redact-ghu" "[REDACTED]" "$(redact 'tok ghu_faketoken1 y' | awk '{print $2}')"
assert_eq "redact-ghr" "[REDACTED]" "$(redact 'tok ghr_faketoken1 y' | awk '{print $2}')"
assert_eq "redact-xoxr" "[REDACTED]" "$(redact 'tok xoxr-fake1 y' | awk '{print $2}')"
assert_eq "redact-xoxo" "[REDACTED]" "$(redact 'tok xoxo-fake2 y' | awk '{print $2}')"
assert_eq "redact-xoxe" "[REDACTED]" "$(redact 'tok xoxe-fake3 y' | awk '{print $2}')"
assert_eq "redact-aiza" "[REDACTED]" "$(redact 'key AIza0123456789AbCdEfGhIjKlMnOpQrStUvWXY end' | awk '{print $2}')"
assert_eq "redact-aiza-short" "AIzaShort" "$(redact 'tok AIzaShort y' | awk '{print $2}')"
assert_eq "redact-meta-assign" "META_API_KEY=[REDACTED]!" "$(redact 'leak META_API_KEY=hunter2hunter2hunter2!' | awk '{print $2}')"
assert_eq "redact-live-bare" "[REDACTED]" "$(META_API_KEY='fake.live/key+abc=123' redact 'oops fake.live/key+abc=123 end' | awk '{print $2}')"
assert_eq "redact-live-empty" "plain text stays" "$(META_API_KEY='' redact 'plain text stays' )"
assert_eq "redact-live-unset" "plain text stays" "$(env -u META_API_KEY "SCRIPT_DIR=${SCRIPT_DIR}" bash -c '. "${SCRIPT_DIR}/lib.sh"; redact "plain text stays"')"

# --- redact_json_key (live key behind JSON escapes) ---
# Fixture key carries regex metachars (., /, +, =): split/join must
# replace it literally (gsub would read those as a pattern).
jkey='fake.live/key+abc=123'
jfix="$(mktemp)"
cat > "${jfix}" <<'EOF'
{"verdict":"ok","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"oops fake.live\/key+abc=123 end"}],"next_steps":[]}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.findings[0].body')"
assert_eq "redactjson-escaped-slash" "oops [REDACTED] end" "${got}"
cat > "${jfix}" <<'EOF'
{"a":{"b":["x fake.live/key+abc\u003d123 y"]},"v":"fakexlive/key+abc=123 stays"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a.b[0]')"
assert_eq "redactjson-nested-u-escape" "x [REDACTED] y" "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.v')"
assert_eq "redactjson-literal-nomatch" "fakexlive/key+abc=123 stays" "${got}"
got1="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}")"
got2="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}")"
assert_eq "redactjson-deterministic" "${got1}" "${got2}"
case "${got1}" in *"${jkey}"*) got_left="yes";; *) got_left="no";; esac
assert_eq "redactjson-no-key-bytes" "no" "${got_left}"
cat > "${jfix}" <<'EOF'
{"a":{"b":["x fake.live\\u002fkey+abc\\u003d123 y"]},"v":"keep \\u0041 literal"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a.b[0]')"
assert_eq "redactjson-doubly-escaped" "x [REDACTED] y" "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.v')"
assert_eq "redactjson-keyfree-escapes-kept" 'keep \u0041 literal' "${got}"
cat > "${jfix}" <<'EOF'
{"a":{"b":["quoted \"word\" then fake.live\\u002fkey+abc\\u003d123 y","line1\nline2 fake.live\\u002fkey+abc\\u003d123 y"]}}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a.b[0]')"
assert_eq "redactjson-doubly-escaped-quote" 'quoted "word" then [REDACTED] y' "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a.b[1]')"
case "${got}" in *"[REDACTED]"*) got_nl="redacted";; *) got_nl="leaked";; esac
assert_eq "redactjson-doubly-escaped-newline" "redacted" "${got_nl}"
case "${got}" in *"fake.live"*) got_left="yes";; *) got_left="no";; esac
assert_eq "redactjson-newline-no-fragment" "no" "${got_left}"
python3 -c "import json; print(json.dumps({'a': 'x fake.live' + '\\\\' * 32 + 'u002fkey+abc' + '\\\\' * 32 + 'u003d123 y'}))" > "${jfix}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-deep-nesting" "x [REDACTED] y" "${got}"
if printf 'not json' | META_API_KEY="${jkey}" redact_json_key >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "redactjson-nonjson-rc" "nonzero" "${got_rc}"
if printf '{}' | META_API_KEY='' redact_json_key >/dev/null 2>&1; then got_rc="0"; else got_rc=$?; fi
assert_eq "redactjson-empty-key-rc" "1" "${got_rc}"
cat > "${jfix}" <<'EOF'
{"a":"oops fake\\.live/key+abc=123 end"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-markdown-escape" "oops [REDACTED] end" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left[A](https://e.example)right","b":"left[A]right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-link-split-redacted" "[REDACTED]" "${got}"
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.b')"
assert_eq "redactjson-shortcut-split-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left` A `right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-codespan-split-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left[*A*]right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-composed-split-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left[` A `]right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-codespan-link-split-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left![](u)[*A*]right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-image-composed-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left![[]()](u)[*A*]right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-nested-image-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left`` A ``right","b":"left\u200bAright"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-multibacktick-redacted" "[REDACTED]" "${got}"
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.b')"
assert_eq "redactjson-zerowidth-redacted" "[REDACTED]" "${got}"
cat > "${jfix}" <<'EOF'
{"a":"left\u2066A\u2069right"}
EOF
got="$(META_API_KEY='leftAright' redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-bidi-redacted" "[REDACTED]" "${got}"
if grep -q 'canonicalize_links < "${review_file}"' "${SCRIPT_DIR}/run.sh"; then got_rc="present"; else got_rc="absent"; fi
assert_eq "run-no-canon-on-json" "absent" "${got_rc}"
# NUL-split key: an embedded U+0000 keeps the halves non-contiguous here,
# but Bash discards NUL bytes when the keyless post step extracts decoded
# strings into variables, rejoining the credential. Stripping NULs while
# the key is available must make the split key redactable, normalize
# key-free NULs away, and emit no NUL at all.
cat > "${jfix}" <<'EOF'
{"a":"leak fake.live/key+abc\u0000=123 end","b":"plain\u0000nul"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-nul-split-redacted" "leak [REDACTED] end" "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.b')"
assert_eq "redactjson-nul-normalized" "plainnul" "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}")"
case "${got}" in *"\u0000"*) got_nul="present";; *) got_nul="absent";; esac
assert_eq "redactjson-no-nul-emitted" "absent" "${got_nul}"
cat > "${jfix}" <<'EOF'
{"a":"leak fake.live/key+abc\\u0000=123 end"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-nul-escaped-split-redacted" "leak [REDACTED] end" "${got}"
# Image-split key: post-side strip_images deletes the token between the
# halves, so the stripped form must be checked (and emitted) while the
# key is available; key-free images stay untouched.
cat > "${jfix}" <<'EOF'
{"a":"leak fake.live![](https://example.invalid/i)/key+abc=123 end","b":"keep ![alt](https://d.example/x) text"}
EOF
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.a')"
assert_eq "redactjson-img-split-redacted" "leak [REDACTED] end" "${got}"
got="$(META_API_KEY="${jkey}" redact_json_key < "${jfix}" | jq -r '.b')"
assert_eq "redactjson-img-keyfree-kept" "keep ![alt](https://d.example/x) text" "${got}"
rm -f "${jfix}"

# --- decode_json_escapes (mixed prose + JSON fragment; the run.sh P1) ---
# redact_json_key rejects this whole input as invalid JSON, so the run.sh
# fallback path must decode escapes before byte redaction — otherwise the
# reversible escaped key survives into the log / posted body.
mixkey='fake.live/key+abc=123'
mixfix="$(mktemp)"
printf '%s' 'error: {"key":"fake.live\/key+abc\u003d123"} tail' > "${mixfix}"
got="$(decode_json_escapes < "${mixfix}")"
assert_eq "decode-mixed" 'error: {"key":"fake.live/key+abc=123"} tail' "${got}"
got="$(META_API_KEY="${mixkey}" redact "$(decode_json_escapes < "${mixfix}")")"
assert_eq "decode-mixed-redacted" 'error: {"key":"[REDACTED]"} tail' "${got}"
case "${got}" in *"fake.live"*) got_left="yes";; *) got_left="no";; esac
assert_eq "decode-mixed-no-key-fragment" "no" "${got_left}"
# Doubly escaped sequences decode too (bounded fixed point): JSON nested
# in another JSON string writes \\u0041 for "A", and sparing escaped
# backslashes would leave a doubly escaped live key reversible in the
# log / posted body after redaction.
got="$(printf '%s' 'keep \\u0041 literal, \/ slash' | decode_json_escapes)"
assert_eq "decode-doubly-escaped" 'keep A literal, / slash' "${got}"
printf '%s' 'error: {"key":"fake.live\\u002fkey+abc\\u003d123"} tail' > "${mixfix}"
got="$(META_API_KEY="${mixkey}" redact "$(decode_json_escapes < "${mixfix}")")"
assert_eq "decode-double-mixed-redacted" 'error: {"key":"[REDACTED]"} tail' "${got}"
case "${got}" in *"fake.live"*) got_left="yes";; *) got_left="no";; esac
assert_eq "decode-double-no-key-fragment" "no" "${got_left}"
python3 -c "print('err fake.live' + '\\\\' * 100000 + 'u002fkey+abc=123 tail', end='')" > "${mixfix}"
got="$(META_API_KEY="${mixkey}" redact "$(decode_json_escapes < "${mixfix}")")"
assert_eq "decode-deep-run-redacted" 'err [REDACTED] tail' "${got}"
rm -f "${mixfix}"

# --- neutralize_workflow_commands (run.sh stderr-tail P2) ---
# Decoded model stderr can smuggle `\n::error...` via `\u000a\u003a...`
# escapes; the runner would execute it as a workflow command on print.
got="$(printf '%s' '::error::forged annotation' | neutralize_workflow_commands)"
assert_eq "wfcmd-leading" " ::error::forged annotation" "${got}"
got="$(printf 'first line\n::warning::second\nplain ::mid:: kept' | neutralize_workflow_commands)"
assert_eq "wfcmd-multiline" "$(printf 'first line\n ::warning::second\nplain ::mid:: kept')" "${got}"
got="$(printf '\r::group::leak' | neutralize_workflow_commands)"
assert_eq "wfcmd-cr" " ::group::leak" "${got}"
got="$(printf '%s' 'x\u000a\u003a\u003aerror\u003a\u003afake' | decode_json_escapes | neutralize_workflow_commands)"
assert_eq "wfcmd-decoded-smuggle" "$(printf 'x\n ::error::fake')" "${got}"
got="$(printf 'a\rb' | neutralize_workflow_commands)"
assert_eq "wfcmd-cr-separator" "a b" "${got}"
# CR-split key: redact strips CRs before matching, neutralize uses a
# space separator, and a second redact after neutralize (run.sh order)
# must leave no contiguous credential.
crkey='fake.live/key+abc=123'
got="$(META_API_KEY="${crkey}" redact "$(printf 'leak fake.live/key+abc\r=123 end')" | neutralize_workflow_commands)"
got="$(META_API_KEY="${crkey}" redact "${got}")"
assert_eq "wfcmd-cr-split-redacted" "leak [REDACTED] end" "${got}"
crfix="$(mktemp)"
printf '%s' '{"a":"leak fake.live/key+abc\r=123 end"}' > "${crfix}"
got="$(META_API_KEY="${crkey}" redact_json_key < "${crfix}" | jq -r '.a')"
assert_eq "redactjson-cr-split-redacted" "leak [REDACTED] end" "${got}"
rm -f "${crfix}"

# --- strip_images ---
got="$(printf '%s' 'see ![pixel](https://a.example/p?d=1) and [docs](https://d.example/x) ok' | strip_images)"
assert_eq "images-inline" "see pixel and [docs](https://d.example/x) ok" "${got}"
got="$(printf '%s' 'ref ![a][b] tag <img alt="dia" src="https://e.example/x"> bare <img src="https://f.example/y">' | strip_images)"
assert_eq "images-ref-html" "ref a tag dia bare " "${got}"
got="$(printf '%s' 'paren ![p](https://g.example/u(1).png) squote <img alt='"'"'sq'"'"' src="https://h.example/y">' | strip_images)"
assert_eq "images-edge" "paren p squote sq" "${got}"
got="$(printf '%s' $'see ![pixel]\n\n[pixel]: https://a.example/p and [kept](https://d.example/x)' | strip_images)"
assert_eq "images-shortcut-ref" $'see [pixel]\n\n[pixel]: https://a.example/p and [kept](https://d.example/x)' "${got}"
got="$(printf '%s' 'x ![pixel](https://example.invalid/a((b)).png) y and ![t](http://e.example/a((b(c))d).png)' | strip_images)"
assert_eq "images-nested-parens" "x pixel y and t" "${got}"
got="$(printf '%s' 'x ![outer [inner]](https://example.invalid/pixel) y, ![a [b [c]]](https://example.invalid/p), ![e\]s](https://e.example/u)' | strip_images)"
assert_eq "images-nested-alt" 'x outer [inner] y, a [b [c]], e\]s' "${got}"
got="$(printf '%s' '![o [i]][b] and ![o [i]]' | strip_images)"
assert_eq "images-nested-ref" "o [i] and [o [i]]" "${got}"
got="$(printf '![a\nb](https://e.example/u) tail' | strip_images)"
assert_eq "images-multiline" "$(printf 'a\nb tail')" "${got}"
got="$(printf '%s' 'left!<img src=x>[]()right' | strip_images)"
assert_eq "images-cross-form-fixed-point" "leftright" "${got}"

# --- strip_html_comments ---
got="$(printf '%s' 'x<!-- hidden -->y' | strip_html_comments)"
assert_eq "html-comment-replaced" 'x [HTML comment removed] y' "${got}"
got="$(printf 'a<!-- one\ntwo -->b' | strip_html_comments)"
assert_eq "html-comment-multiline" "$(printf 'a [HTML comment removed] b')" "${got}"
got="$(printf '%s' 'keep <!-- unterminated' | strip_html_comments)"
assert_eq "html-comment-unterminated-kept" 'keep <!-- unterminated' "${got}"

# --- neutralize_html_entities ---
got="$(printf '%s' 'left&#65;right &#x42; &amp; a & b' | neutralize_html_entities)"
assert_eq "entities-neutralized" 'left&amp;#65;right &amp;#x42; &amp;amp; a & b' "${got}"
got="$(printf '%s' 'plain &notaref text &; end' | neutralize_html_entities)"
assert_eq "entities-bare-amp-kept" 'plain &notaref text &; end' "${got}"

# --- strip_html_tags ---
got="$(printf '%s' 'left<span></span>right <b class="x">bold</b> a < b' | strip_html_tags)"
assert_eq "html-tags-replaced" 'left [HTML removed]  [HTML removed] right  [HTML removed] bold [HTML removed]  a < b' "${got}"

# --- strip_ansi ---
got="$(printf 'left\033[31mright\033[0m end\033[1K!' | strip_ansi)"
assert_eq "ansi-stripped" 'leftright end!' "${got}"

# --- schema constrains next_steps items ---
if jq -e '.properties.next_steps.items.type == "string"' "${SCRIPT_DIR}/schema.json" >/dev/null 2>&1; then got_s="string"; else got_s="other"; fi
assert_eq "schema-next-steps-strings" "string" "${got_s}"

# --- strip_empty_links ---
got="$(printf '%s' 'left[]()right and [](https://x.example) mid [][r] end [text](https://y.example) kept' | strip_empty_links)"
assert_eq "empty-links-removed" 'leftright and  mid  end [text](https://y.example) kept' "${got}"

# --- strip_intraword_markers ---
got="$(printf '%s' 'left*A*right and left**B**right and left~~C~~right' | strip_intraword_markers)"
assert_eq "intraword-markers-removed" 'leftAright and leftBright and leftCright' "${got}"
got="$(printf '%s' 'a * b and *em* word and snake_case and 2 * 3' | strip_intraword_markers)"
assert_eq "intraword-spaced-kept" 'a * b and *em* word and snake_case and 2 * 3' "${got}"
got="$(printf 'x`code`y end' | strip_intraword_markers)"
assert_eq "intraword-backtick-removed" 'xcodey end' "${got}"
got="$(printf '%s' 'fake.*live*/key+abc=123 x' | strip_intraword_markers)"
assert_eq "punct-bounded-markers-removed" 'fake.live/key+abc=123 x' "${got}"
got="$(printf '%s' 'fake._live_/key and a_b_c stay' | strip_intraword_markers)"
assert_eq "punct-bounded-underscore-removed" 'fake.live/key and a_b_c stay' "${got}"

# --- strip_markdown_escapes ---
got="$(printf '%s' 'fake\.live a\*b c\n d \\ e' | strip_markdown_escapes)"
assert_eq "markdown-escapes-decoded" 'fake.live a*b c\n d \ e' "${got}"

# --- strip_invisible_chars ---
got="$(printf 'a\xe2\x80\x8bb\xef\xbb\xbfc\xc2\xadd' | strip_invisible_chars)"
assert_eq "invisible-stripped" 'abcd' "${got}"
got="$(printf 'a\xe2\x81\xa6b\xe2\x81\xa9c' | strip_invisible_chars)"
assert_eq "invisible-bidi-stripped" 'abc' "${got}"

# --- strip_code_spans ---
got="$(printf '%s' 'left` A `right and `code` x and ``a`b`` y' | strip_code_spans)"
assert_eq "code-spans-normalized" 'leftAright and code x and a`b y' "${got}"
got="$(printf '%s' 'left<?hidden?>right' | strip_html_tags)"
assert_eq "html-pi-replaced" 'left [HTML removed] right' "${got}"

# --- canonicalize_links ---
got="$(printf '%s' 'see [docs](https://d.example/x) and left[A](https://e.example)right and [t][r1] end' | canonicalize_links)"
assert_eq "links-canonicalized" 'see docs (https://d.example/x) and leftA (https://e.example)right and t (r1) end' "${got}"
got="$(printf '%s' 'nested [a [b] c](https://e.example/u(1)) tail' | canonicalize_links)"
assert_eq "links-nested" 'nested a [b] c (https://e.example/u(1)) tail' "${got}"
got="$(printf 'left[A]right see [docs] here\n\n[A]: https://e.example/x' | canonicalize_links)"
assert_eq "links-shortcut-defined" "$(printf 'leftAright see [docs] here\n')" "${got}"
got="$(printf 'see [setting] here\n\n```\n[setting]: dangerous-value\n```\n' | canonicalize_links)"
assert_eq "links-fenced-def-preserved" "$(printf 'see [setting] here\n\n```\n[setting]: dangerous-value\n```\n')" "${got}"
got="$(printf 'ex ` A ` y\n\n```\n[setting]: dangerous-value\n```\n' | strip_code_spans | canonicalize_links)"
assert_eq "pipeline-fenced-def-preserved" "$(printf 'ex A y\n\n```\n[setting]: dangerous-value\n```\n')" "${got}"
got="$(printf '````\n```\n[setting]: dangerous-value\n````\nsee [setting]\n' | strip_code_spans | canonicalize_links)"
assert_eq "pipeline-fence-length-preserved" "$(printf '````\n```\n[setting]: dangerous-value\n````\nsee [setting]\n')" "${got}"

# --- protect/restore code spans ---
got="$(printf 'pre `a*b` mid `\\.` post' | protect_code_spans | strip_markdown_escapes | strip_intraword_markers | restore_code_spans)"
assert_eq "codespan-content-preserved" 'pre `a*b` mid `\.` post' "${got}"
got="$(printf 'x `keep me` y' | protect_code_spans)"
case "${got}" in *'`'*) got_p="raw";; *) got_p="tokenized";; esac
assert_eq "codespan-tokenized" "tokenized" "${got_p}"
got="$(printf 'MUSECS6162Z and `x` end' | protect_code_spans | restore_code_spans)"
assert_eq "codespan-sentinel-escaped" 'MUSECSX6162Z and `x` end' "${got}"
got="$(printf 'MUSECSdeadbeefZ x' | MUSE_CS_NONCE='cafe1234' restore_code_spans)"
assert_eq "codespan-wrong-nonce-kept" 'MUSECSdeadbeefZ x' "${got}"
got="$( (export MUSE_CS_NONCE='cafe1234'; printf 'a `b` c' | protect_code_spans | restore_code_spans) )"
assert_eq "codespan-nonce-roundtrip" 'a `b` c' "${got}"
got="$(printf '```html\n<p>`x`</p>\n```\na*B*c end' | strip_intraword_markers)"
assert_eq "intraword-fence-preserved" "$(printf '```html\n<p>`x`</p>\n```\naBc end')" "${got}"
got="$(printf '%s' 'see <https://docs.github.com/en/actions> and <a@b.com> and <b>bold</b>' | strip_html_tags)"
assert_eq "html-autolinks-kept" 'see https://docs.github.com/en/actions and a@b.com and  [HTML removed] bold [HTML removed] ' "${got}"

# --- trunc_bytes_marked ---
got="$(printf 'abcdefghij' | trunc_bytes_marked 10)"
assert_eq "trunc-marked-under" 'abcdefghij' "${got}"
got="$(printf 'abcdefghijklmnopqrstuvwxyz0123456789ABCD' | trunc_bytes_marked 36)"
assert_eq "trunc-marked-over" "$(printf 'abcd\n\n[... truncated for length ...]')" "${got}"
got_len="$(printf 'abcdefghijklmnopqrstuvwxyz0123456789ABCD' | trunc_bytes_marked 36 | wc -c | tr -d ' ')"
assert_eq "trunc-marked-within-budget" "36" "${got_len}"
crf2="$(mktemp)"
printf '%s' '{"a":"leak split!<img src=x>[]()key123456 end"}' > "${crf2}"
got="$(META_API_KEY='splitkey123456' redact_json_key < "${crf2}" | jq -r '.a')"
assert_eq "redactjson-img-cross-redacted" "leak [REDACTED] end" "${got}"
rm -f "${crf2}"
assert_eq "redact-assign" 'api_key="[REDACTED]"' "$(redact 'api_key="abcDEF1234567890"')"
assert_eq "redact-token-colon" 'token: [REDACTED]' "$(redact 'token: abcDEF1234567890')"
assert_eq "redact-prose-kept" "no token here" "$(redact 'no token here')"
assert_eq "redact-model-name-kept" "muse-spark" "$(redact 'muse-spark')"
jh="eyJhbGciOiJIUzI1NiJ9"
jp="eyJzdWIiOiIxMjM0NTY3ODkwIn0"
js="SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw"
jwt="${jh}.${jp}.${js}"
assert_eq "redact-jwt" "[REDACTED-JWT]" "$(redact "${jwt}")"

# --- seen_add (newline-path dedup; the exact P2 scenario) ---
seen_reset
seen_add "$(printf '!x\napps/web/AGENTS.md')"
seen_add "apps/web/AGENTS.md"
assert_eq "seen-keeps-both" "2" "${#MUSE_CANDIDATES[@]}"
seen_add "apps/web/AGENTS.md"
assert_eq "seen-dedupes" "2" "${#MUSE_CANDIDATES[@]}"
seen_add "my dir/AGENTS.md"
seen_add "my dir/AGENTS.md"
assert_eq "seen-spaces-dedupe" "3" "${#MUSE_CANDIDATES[@]}"
seen_reset
assert_eq "seen-reset" "0" "${#MUSE_CANDIDATES[@]}"

# --- trust_base ---
assert_eq "trust-default" "true" "$(trust_base "main" "main" "true")"
assert_eq "trust-stacked" "false" "$(trust_base "feature" "main" "true")"
assert_eq "trust-nobase" "false" "$(trust_base "main" "main" "false")"
assert_eq "trust-unknown-default" "false" "$(trust_base "main" "" "true")"

# --- manifest_paths (backslash-first escaping; the collect.sh P2) ---
# A literal backslash-n in a filename and a real newline must serialize
# distinctly, or the shell-disabled reviewer cannot re-derive the path.
man_fix="$(mktemp)"
python3 -c "import json; json.dump([{'filename': 'plain.ts'}, {'filename': 'a\\\\nb'}, {'filename': 'a\nb'}], open('${man_fix}', 'w'))"
got="$(manifest_paths "${man_fix}")"
assert_eq "manifest-escape" "$(printf 'plain.ts\na\\\\nb\na\\nb')" "${got}"
col_fix="$(mktemp)"
python3 -c "import json; json.dump([{'filename': 'x\\\\ny'}, {'filename': 'x\ny'}], open('${col_fix}', 'w'))"
got1="$(manifest_paths "${col_fix}" | head -n 1)"
got2="$(manifest_paths "${col_fix}" | tail -n 1)"
if [[ "${got1}" == "${got2}" ]]; then got_same="yes"; else got_same="no"; fi
assert_eq "manifest-distinct" "no" "${got_same}"
if manifest_paths "/nonexistent-muse-test-$$" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "manifest-missing-rc" "nonzero" "${got_rc}"
python3 -c "import json; json.dump([{'filename': 'new.ts', 'previous_filename': 'old.ts'}, {'filename': 'plain.ts', 'previous_filename': ''}, {'filename': 'solo.ts'}], open('${man_fix}', 'w'))"
got="$(manifest_paths "${man_fix}")"
assert_eq "manifest-rename-source" "$(printf 'old.ts -> new.ts\nplain.ts\nsolo.ts')" "${got}"
python3 -c "import json; json.dump([{'filename': 'a -> b'}, {'filename': 'b', 'previous_filename': 'a'}], open('${man_fix}', 'w'))"
got="$(manifest_paths "${man_fix}")"
assert_eq "manifest-rename-delimiter-escaped" "$(printf 'a -\\> b\na -> b')" "${got}"
python3 -c "import json; json.dump([{'filename': 'a\rb.ts'}], open('${man_fix}', 'w'))"
got="$(manifest_paths "${man_fix}")"
assert_eq "manifest-cr-escaped" 'a\rb.ts' "${got}"
rm -f "${man_fix}" "${col_fix}"

# --- ranges.pl ---
diff_fix="$(mktemp)"
printf 'diff --git "a/foo\\tb.ts" "b/foo\\tb.ts"\n--- "a/foo\\tb.ts"\n+++ "b/foo\\tb.ts"\n@@ -1,3 +1,4 @@ ctx\n+x\n+++ b/forged.ts\n+y\n kept\ndiff --git a/p.ts b/p.ts\n--- a/p.ts\n+++ b/p.ts\n@@ -10 +12,2 @@\n+y\n+z\n--- b/victim.ts\n+++ b/other.ts\n@@ -20 +22,2 @@\n+q\n+r\ndiff --git a/d.ts b/d.ts\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/my file.ts b/my file.ts\n--- "a/my file.ts"\t\n+++ "b/my file.ts"\t\n@@ -2 +2 @@\n+z\n' > "${diff_fix}"
got="$(perl "${SCRIPT_DIR}/ranges.pl" "${diff_fix}")"
assert_eq "ranges-json" '[{"path":"foo\u0009b.ts","start":1,"end":4},{"path":"p.ts","start":12,"end":13},{"path":"p.ts","start":22,"end":23},{"path":"my file.ts","start":2,"end":2}]' "${got}"
if printf '%s' "${got}" | jq empty 2>/dev/null; then got_jq="yes"; else got_jq="no"; fi
assert_eq "ranges-valid-json" "yes" "${got_jq}"
assert_eq "ranges-missing-file" "[]" "$(perl "${SCRIPT_DIR}/ranges.pl" "/nonexistent-muse-test-$$")"
# Truncation clamp: a header declaring more new-side lines than the
# (byte-cut) body contains validates only the lines actually present,
# and a hunk with no body present validates nothing.
printf 'diff --git a/t.ts b/t.ts\n--- a/t.ts\n+++ b/t.ts\n@@ -5 +10,6 @@\n+y\n+z\n@@ -30 +40,3 @@\n' > "${diff_fix}"
got="$(perl "${SCRIPT_DIR}/ranges.pl" "${diff_fix}")"
assert_eq "ranges-truncated-clamp" '[{"path":"t.ts","start":10,"end":11}]' "${got}"
rm -f "${diff_fix}"

# --- clean.jq + validate.jq ---
find_fix="$(mktemp)"; ranges_fix="$(mktemp)"; files_fix="$(mktemp)"
cat > "${find_fix}" <<'EOF'
{"verdict":"v","findings":[
 {"path":"a.ts","line":12,"severity":"high","title":"T1","body":"B1"},
 {"path":"a.ts","line":99,"severity":"low","title":"T2","body":"B2"},
 {"path":"b.ts","line":5,"severity":"low","title":"T5","body":"B5"},
 {"path":"a.ts","line":0,"severity":"low","title":"T3","body":"B3"},
 {"path":"nope.ts","line":0,"severity":"low","title":"T4","body":"B4"},
 {"path":"a.ts","line":"x","severity":"low","title":"BAD","body":"B"},
 {"path":7,"line":3,"severity":"low","title":"BAD2","body":"B"}
],"next_steps":[]}
EOF
printf '[{"path":"a.ts","start":10,"end":15}]' > "${ranges_fix}"
printf '[{"filename":"a.ts"}]' > "${files_fix}"
jq -f "${SCRIPT_DIR}/clean.jq" "${find_fix}" > "${find_fix}.clean" && mv "${find_fix}.clean" "${find_fix}"
assert_eq "clean-keeps-5" "5" "$(jq -r '.findings | length' "${find_fix}")"
got="$(jq --slurpfile ranges "${ranges_fix}" --slurpfile files "${files_fix}" -f "${SCRIPT_DIR}/validate.jq" "${find_fix}" | jq -c '{v:[.valid[].title],s:[.summary_only[]|{t:.title,o:(.orphaned//false),u:(.unverified//false)}]}')"
assert_eq "validate-split" '{"v":["T1"],"s":[{"t":"T3","o":false,"u":false},{"t":"T2","o":false,"u":true},{"t":"T5","o":true,"u":false},{"t":"T4","o":true,"u":false}]}' "${got}"
cat > "${find_fix}" <<'EOF'
{"verdict":"v","findings":[
 {"path":"a.ts","line":5,"severity":"low","title":42,"body":"B"},
 {"path":"a.ts","line":6,"severity":"low","title":"T","body":{"x":1}},
 {"path":"a.ts","line":7,"severity":"low","body":"B"},
 {"path":"a.ts","line":71,"severity":"low","title":"","body":"B"},
 {"path":"a.ts","line":72,"severity":"low","title":"T","body":""},
 {"path":"","line":8,"severity":"low","title":"EMPTY","body":"B"},
 {"path":"a.ts","line":9,"severity":{"x":1},"title":"S1","body":"B"},
 {"path":"a.ts","line":10,"severity":"Bogus","title":"S2","body":"B"}
],"next_steps":["ok",7,{"x":1},null]}
EOF
jq -f "${SCRIPT_DIR}/clean.jq" "${find_fix}" > "${find_fix}.clean" && mv "${find_fix}.clean" "${find_fix}"
assert_eq "clean-drops-untitled" '[]' "$(jq -c '[.findings[] | select(.line == 7 or .line == 71 or .line == 72)]' "${find_fix}")"
assert_eq "clean-next-steps" '["ok"]' "$(jq -c '.next_steps' "${find_fix}")"
assert_eq "clean-severity-coerce" '["low","low"]' "$(jq -c '[.findings[] | select(.line == 9 or .line == 10) | .severity]' "${find_fix}")"
rm -f "${find_fix}" "${ranges_fix}" "${files_fix}"

# --- dedupe.jq ---
dup_fix="$(mktemp)"
cat > "${dup_fix}" <<'EOF'
[{"user":{"login":"github-actions[bot]"},"body":"<!-- muse-code-review sha:AAA base:BBB -->\nreal review","submitted_at":"2020-01-01T00:00:00Z"},
 {"user":{"login":"github-actions[bot]"},"body":"<!-- muse-code-review sha:AAA base:BBB -->\n<!-- muse-fallback:v1 -->\nfallback"},
 {"user":{"login":"someone"},"body":"<!-- muse-code-review sha:AAA base:BBB -->\nquoted","submitted_at":"2020-01-01T00:00:00Z"},
 {"user":{"login":"github-actions[bot]"},"body":"<!-- muse-code-review sha:ZZZ base:BBB -->\n<!-- muse-fallback:v1 -->\nfallback","submitted_at":"2999-01-01T00:00:00Z"},
 {"user":{"login":"github-actions[bot]"},"body":"<!-- muse-code-review sha:ZZZ base:BBB -->\n<!-- muse-fallback:v1 -->\nfallback","submitted_at":"2020-01-01T00:00:00Z"}]
EOF
got="$(jq -s --arg marker '<!-- muse-code-review sha:AAA base:BBB -->' -f "${SCRIPT_DIR}/dedupe.jq" "${dup_fix}")"
assert_eq "dedupe-real-only" "1" "${got}"
got="$(jq -s --arg marker '<!-- muse-code-review sha:AAA base:BBB -->' -f "${SCRIPT_DIR}/fallback.jq" "${dup_fix}")"
assert_eq "fallback-same-and-recent" "2" "${got}"
rm -f "${dup_fix}"

# --- null-body dedupe fixtures ---
# A bodyless review (API body null, or the key missing) must not error
# either filter: the pre-run caller maps jq failure to 0 (existing marker
# ignored, duplicate billed review) while the retry caller maps it to 1
# (needed retry suppressed).
null_fix="$(mktemp)"
cat > "${null_fix}" <<'EOF'
[{"user":{"login":"github-actions[bot]"},"body":null,"submitted_at":"2020-01-01T00:00:00Z"},
 {"user":{"login":"github-actions[bot]"},"submitted_at":"2020-01-01T00:00:00Z"},
 {"user":{"login":"github-actions[bot]"},"body":"<!-- muse-code-review sha:AAA base:BBB -->\nreal review","submitted_at":"2020-01-01T00:00:00Z"}]
EOF
got="$(jq -s --arg marker '<!-- muse-code-review sha:AAA base:BBB -->' -f "${SCRIPT_DIR}/dedupe.jq" "${null_fix}")"
assert_eq "dedupe-null-body" "1" "${got}"
got="$(jq -s --arg marker '<!-- muse-code-review sha:AAA base:BBB -->' -f "${SCRIPT_DIR}/fallback.jq" "${null_fix}")"
assert_eq "fallback-null-body" "0" "${got}"
rm -f "${null_fix}"

# --- operator docs honesty (runbook + workflow header) ---
# The earlier "minimum scope: a key that can only run model prompts"
# claim described a credential Meta does not offer (keys are
# team-scoped), and the runbook must keep the Contributor-mode
# activation requirement visible. Static asserts, same style as the
# protocol cross-check below.
runbook_path="${SCRIPT_DIR}/../../../docs/runbooks/muse-code-review.md"
if grep -q "Contributor mode" "${runbook_path}" 2>/dev/null; then got_doc="yes"; else got_doc="no"; fi
assert_eq "docs-contributor-mode" "yes" "${got_doc}"
if grep -q "only run model prompts" "${runbook_path}" "${SCRIPT_DIR}/../../workflows/muse-code-review.yml" 2>/dev/null; then got_doc="found"; else got_doc="absent"; fi
assert_eq "docs-no-prompts-only-scope" "absent" "${got_doc}"
if grep -q "MUSE_REVIEW_ENABLED" "${runbook_path}" 2>/dev/null && grep -q "MUSE_REVIEW_ENABLED" "${SCRIPT_DIR}/../../workflows/muse-code-review.yml" 2>/dev/null; then got_doc="yes"; else got_doc="no"; fi
assert_eq "docs-rollout-gate" "yes" "${got_doc}"
# The selftest asserts against the runbook above, so a runbook-only
# change must trigger it in both push and pull_request path filters.
selftest_path="${SCRIPT_DIR}/../../workflows/muse-review-selftest.yml"
assert_eq "selftest-runbook-trigger" "2" "$(grep -c 'docs/runbooks/muse-code-review.md' "${selftest_path}" 2>/dev/null || echo 0)"
if grep -q 'redact "\$(redact' "${SCRIPT_DIR}/run.sh" 2>/dev/null; then got_doc="yes"; else got_doc="no"; fi
assert_eq "run-redact-after-neutralize" "yes" "${got_doc}"
trust_path="${SCRIPT_DIR}/../../../docs/public-trust-pages.md"
if grep -q "non-Contributor-mode model" "${trust_path}" 2>/dev/null && grep -q "not a Contributor-mode variant" "${trust_path}" 2>/dev/null; then got_doc="yes"; else got_doc="no"; fi
assert_eq "docs-paygo-noncontributor" "yes" "${got_doc}"

# --- schema.json ---
if jq -e '.type == "object" and .additionalProperties == false and (.required | length) == 3' "${SCRIPT_DIR}/schema.json" >/dev/null 2>&1; then got_schema="yes"; else got_schema="no"; fi
assert_eq "schema-shape" "yes" "${got_schema}"

# --- pinned compare inventory merge (collect.sh) ---
# The fallback inventory reads the compare object for the captured
# base...head pair; only its files array is taken, so an error payload
# can never masquerade as a file list.
pages_fix="$(mktemp)"
printf '{"files":[{"filename":"a.ts"},{"filename":"b.ts"}]}\n' > "${pages_fix}"
got="$(jq -s '[.[] | select(type == "object") | (.files // [])] | add // []' "${pages_fix}")"
assert_eq "pages-merge" '[{"filename":"a.ts"},{"filename":"b.ts"}]' "$(printf '%s' "${got}" | jq -c '.')"
printf '{"message":"only errors"}\n' > "${pages_fix}"
got="$(jq -s '[.[] | select(type == "object") | (.files // [])] | add // []' "${pages_fix}")"
assert_eq "pages-all-error" '[]' "$(printf '%s' "${got}" | jq -c '.')"
rm -f "${pages_fix}"

# --- MUSE_REVIEW_PROTOCOL handshake (YAML<->scripts skew) ---
# lib.sh declares the YAML<->scripts contract version; the workflow's
# scriptdir step requires its own expected value and fails closed on
# mismatch. Same-revision YAML and scripts must agree — a contract
# change bumps BOTH values together, and this cross-file assert catches
# a bump that updates only one side.
if [[ "${MUSE_REVIEW_PROTOCOL:-}" =~ ^[0-9]+$ ]]; then got_proto="yes"; else got_proto="no"; fi
assert_eq "protocol-declared" "yes" "${got_proto}"
yaml_proto="$(sed -n 's/^[[:space:]]*expected_protocol=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "${SCRIPT_DIR}/../../workflows/muse-code-review.yml" 2>/dev/null || true)"
assert_eq "protocol-yaml-agrees" "${MUSE_REVIEW_PROTOCOL:-<unset>}" "${yaml_proto:-<missing>}"

# --- guidance.sh candidate cap fails closed (script level) ---
# Discovery past the 500-candidate cap must not post success over partial
# guidance: the phase exits nonzero so Post renders the fallback.
gdir="$(mktemp -d)"
mkdir -p "${gdir}/tmp" "${gdir}/ws"
printf 'root rules\n' > "${gdir}/ws/AGENTS.md"
mkdir -p "${gdir}/ws/.claude"
printf 'root-alt-rule\n' > "${gdir}/ws/.claude/CLAUDE.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${gdir}/tmp/muse-vars.env"
printf '[{"filename":"a.ts"}]' > "${gdir}/tmp/muse-files.json"
guidance_script="${SCRIPT_DIR}/guidance.sh"
if (cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-small-ok" "0" "${got_rc}"
case "$(cat "${gdir}/tmp/muse-guidance.md" 2>/dev/null)" in *"root rules"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-small-emits-root" "yes" "${got_g}"
# First-existing rule: AGENTS.md wins the root level, so the
# .claude/CLAUDE.md sibling is omitted while AGENTS.md exists...
case "$(cat "${gdir}/tmp/muse-guidance.md" 2>/dev/null)" in *"root-alt-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-alt-suppressed-by-winner" "no" "${got_g}"
# ...and emitted once the winner is absent.
rm "${gdir}/ws/AGENTS.md"
(cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${gdir}/tmp/muse-guidance.md" 2>/dev/null)" in *"root-alt-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-root-alt-location" "yes" "${got_g}"
printf 'root rules\n' > "${gdir}/ws/AGENTS.md"
mkdir -p "${gdir}/ws/a/b" "${gdir}/ws/a/.agents"
printf 'parent-rule\n' > "${gdir}/ws/a/AGENTS.md"
printf 'child-rule\n' > "${gdir}/ws/a/b/AGENTS.md"
printf 'scoped-alt-rule\n' > "${gdir}/ws/a/.agents/AGENTS.md"
printf '[{"filename":"a/b/f.ts"}]' > "${gdir}/tmp/muse-files.json"
(cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
pline="$(grep -n 'parent-rule' "${gdir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
cline="$(grep -n 'child-rule' "${gdir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
if [[ -n "${pline}" && -n "${cline}" ]] && (( pline < cline )); then got_o="root-first"; else got_o="leaf-first"; fi
assert_eq "guidance-root-first-order" "root-first" "${got_o}"
case "$(cat "${gdir}/tmp/muse-guidance.md" 2>/dev/null)" in *"scoped-alt-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-scoped-alt-suppressed" "no" "${got_g}"
rm "${gdir}/ws/a/AGENTS.md"
(cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${gdir}/tmp/muse-guidance.md" 2>/dev/null)" in *"scoped-alt-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-scoped-alt-location" "yes" "${got_g}"
printf 'parent-rule\n' > "${gdir}/ws/a/AGENTS.md"
python3 -c "import json; print(json.dumps([{'filename': 'd%03d/f.ts' % i} for i in range(300)]))" > "${gdir}/tmp/muse-files.json"
if (cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-cap-fails-closed" "nonzero" "${got_rc}"
printf '[{"filename":"a.ts"}]' > "${gdir}/tmp/muse-files.json"
python3 -c "print('x' * 33000)" > "${gdir}/ws/AGENTS.md"
if (cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-truncation-fails-closed" "nonzero" "${got_rc}"
# CLAUDE.md is the suppressed sibling at the root level (AGENTS.md
# wins), so size the three applicable files to exhaust the budget on
# their own: 3 x 32000 content bytes plus block overhead > 96000.
python3 -c "print('x' * 32000)" > "${gdir}/ws/AGENTS.md"
python3 -c "print('y' * 30000)" > "${gdir}/ws/CLAUDE.md"
python3 -c "print('z' * 32000)" > "${gdir}/ws/CONTRIBUTING.md"
mkdir -p "${gdir}/ws/.github"
python3 -c "print('w' * 32000)" > "${gdir}/ws/.github/copilot-instructions.md"
if (cd "${gdir}/ws" && RUNNER_TEMP="${gdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-budget-fails-closed" "nonzero" "${got_rc}"
rm -rf "${gdir}"

# --- guidance.sh base/head copies interleave by candidate scope ---
# A modified parent must not be emitted after an unchanged child:
# batching all base copies before all head copies produced
# parent-base, child-base, parent-head, contradicting the prompt's
# closest-scope-wins precedence. Per candidate, base precedes its head.
idir="$(mktemp -d)"
mkdir -p "${idir}/tmp" "${idir}/ws/a/b"
git -C "${idir}/ws" init -q 2>/dev/null
printf 'parent-base\n' > "${idir}/ws/AGENTS.md"
printf 'child-base\n' > "${idir}/ws/a/b/AGENTS.md"
git -C "${idir}/ws" add -A 2>/dev/null
git -C "${idir}/ws" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
ibase="$(git -C "${idir}/ws" rev-parse HEAD 2>/dev/null)"
printf 'parent-head-modified\n' > "${idir}/ws/AGENTS.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=true\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "${ibase}"
} > "${idir}/tmp/muse-vars.env"
printf '[{"filename":"a/b/f.ts"}]' > "${idir}/tmp/muse-files.json"
guidance_script="${SCRIPT_DIR}/guidance.sh"
(cd "${idir}/ws" && RUNNER_TEMP="${idir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
pbline="$(grep -n 'parent-base' "${idir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
phline="$(grep -n 'parent-head-modified' "${idir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
cbline="$(grep -n 'child-base' "${idir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
if [[ -n "${pbline}" && -n "${phline}" && -n "${cbline}" ]] && (( pbline < phline && phline < cbline )); then got_o="interleaved"; else got_o="batched"; fi
assert_eq "guidance-interleaved-by-scope" "interleaved" "${got_o}"
# First-existing under a trusted base: a head-only CLAUDE.md beside the
# winning AGENTS.md is omitted, not presented as concurrent guidance.
printf 'claude-head-rule\n' > "${idir}/ws/CLAUDE.md"
(cd "${idir}/ws" && RUNNER_TEMP="${idir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${idir}/tmp/muse-guidance.md" 2>/dev/null)" in *"claude-head-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-head-sibling-suppressed" "no" "${got_g}"
case "$(cat "${idir}/tmp/muse-guidance.md" 2>/dev/null)" in *"parent-base"*"parent-head-modified"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-base-winner-retained" "yes" "${got_g}"
rm -rf "${idir}"
# Head winner follows the retained base winner for the same directory:
# base has only CLAUDE.md, the PR adds the higher-priority AGENTS.md;
# the retained base sibling must not read as the later override.
fdir="$(mktemp -d)"
mkdir -p "${fdir}/tmp" "${fdir}/ws"
git -C "${fdir}/ws" init -q 2>/dev/null
printf 'claude-base-only\n' > "${fdir}/ws/CLAUDE.md"
git -C "${fdir}/ws" add -A 2>/dev/null
git -C "${fdir}/ws" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
fbase="$(git -C "${fdir}/ws" rev-parse HEAD 2>/dev/null)"
printf 'agents-head-new\n' > "${fdir}/ws/AGENTS.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=true\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "${fbase}"
} > "${fdir}/tmp/muse-vars.env"
printf '[{"filename":"f.ts"}]' > "${fdir}/tmp/muse-files.json"
(cd "${fdir}/ws" && RUNNER_TEMP="${fdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
cbline="$(grep -n 'claude-base-only' "${fdir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
haline="$(grep -n 'agents-head-new' "${fdir}/tmp/muse-guidance.md" 2>/dev/null | head -n 1 | cut -d: -f1)"
if [[ -n "${cbline}" && -n "${haline}" ]] && (( cbline < haline )); then got_o="base-first"; else got_o="head-first"; fi
assert_eq "guidance-head-winner-after-base" "base-first" "${got_o}"
rm -rf "${fdir}"
# Standalone levels never collide with directory levels: a directory
# literally named `own:CONTRIBUTING.md` must not suppress its scoped
# AGENTS.md just because the root CONTRIBUTING.md minted that level.
cddir="$(mktemp -d)"
mkdir -p "${cddir}/tmp" "${cddir}/ws/own:CONTRIBUTING.md"
printf 'root-contrib-rule\n' > "${cddir}/ws/CONTRIBUTING.md"
printf 'scoped-rule\n' > "${cddir}/ws/own:CONTRIBUTING.md/AGENTS.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${cddir}/tmp/muse-vars.env"
printf '[{"filename":"own:CONTRIBUTING.md/x.ts"}]' > "${cddir}/tmp/muse-files.json"
(cd "${cddir}/ws" && RUNNER_TEMP="${cddir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${cddir}/tmp/muse-guidance.md" 2>/dev/null)" in *"scoped-rule"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-standalone-level-no-collision" "yes" "${got_g}"
rm -rf "${cddir}"
# Newly exposed head winner: deleting the base winner (AGENTS.md)
# exposes an unchanged lower-priority sibling (CLAUDE.md) that applies
# in head even though its bytes never changed and it never entered
# head_list as a differing copy.
edir="$(mktemp -d)"
mkdir -p "${edir}/tmp" "${edir}/ws"
git -C "${edir}/ws" init -q 2>/dev/null
printf 'agents-base\n' > "${edir}/ws/AGENTS.md"
printf 'claude-base\n' > "${edir}/ws/CLAUDE.md"
git -C "${edir}/ws" add -A 2>/dev/null
git -C "${edir}/ws" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
ebase="$(git -C "${edir}/ws" rev-parse HEAD 2>/dev/null)"
rm "${edir}/ws/AGENTS.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=true\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "${ebase}"
} > "${edir}/tmp/muse-vars.env"
printf '[{"filename":"f.ts"}]' > "${edir}/tmp/muse-files.json"
(cd "${edir}/ws" && RUNNER_TEMP="${edir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${edir}/tmp/muse-guidance.md" 2>/dev/null)" in *"claude-base"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-exposed-head-winner" "yes" "${got_g}"
case "$(cat "${edir}/tmp/muse-guidance.md" 2>/dev/null)" in *"agents-base"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-exposed-base-retained" "yes" "${got_g}"
rm -rf "${edir}"
# Invalid UTF-8 in guidance must be byte-escaped, not silently deleted
# by iconv -c: altered directives could otherwise publish as success.
gudir="$(mktemp -d)"
mkdir -p "${gudir}/tmp" "${gudir}/ws"
python3 -c "open('${gudir}/ws/AGENTS.md','wb').write(b'rule ' + bytes([255]) + b'here\n')"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${gudir}/tmp/muse-vars.env"
printf '[{"filename":"f.ts"}]' > "${gudir}/tmp/muse-files.json"
(cd "${gudir}/ws" && RUNNER_TEMP="${gudir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${gudir}/tmp/muse-guidance.md" 2>/dev/null)" in *'rule \xFFhere'*) got_g="escaped";; *) got_g="altered";; esac
assert_eq "guidance-invalid-utf8-escaped" "escaped" "${got_g}"
rm -rf "${gudir}"
# NUL-bearing guidance fails closed: Bash substitution would drop the
# NUL and join directive text while reporting complete guidance.
nudir="$(mktemp -d)"
mkdir -p "${nudir}/tmp" "${nudir}/ws"
python3 -c "open('${nudir}/ws/AGENTS.md','wb').write(b'ruleA' + bytes([0]) + b'ruleB\n')"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${nudir}/tmp/muse-vars.env"
printf '[{"filename":"f.ts"}]' > "${nudir}/tmp/muse-files.json"
if (cd "${nudir}/ws" && RUNNER_TEMP="${nudir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-nul-fails-closed" "nonzero" "${got_rc}"
rm -rf "${nudir}"
# A directory named AGENTS.md in base is a tree, not a guidance blob:
# it must not win first-existing selection over a real CLAUDE.md.
bldir="$(mktemp -d)"
mkdir -p "${bldir}/tmp" "${bldir}/ws/AGENTS.md"
git -C "${bldir}/ws" init -q 2>/dev/null
printf 'inner\n' > "${bldir}/ws/AGENTS.md/inner.txt"
printf 'claude-base\n' > "${bldir}/ws/CLAUDE.md"
git -C "${bldir}/ws" add -A 2>/dev/null
git -C "${bldir}/ws" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
blbase="$(git -C "${bldir}/ws" rev-parse HEAD 2>/dev/null)"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=true\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "${blbase}"
} > "${bldir}/tmp/muse-vars.env"
printf '[{"filename":"f.ts"}]' > "${bldir}/tmp/muse-files.json"
(cd "${bldir}/ws" && RUNNER_TEMP="${bldir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
case "$(cat "${bldir}/tmp/muse-guidance.md" 2>/dev/null)" in *"claude-base"*) got_g="yes";; *) got_g="no";; esac
assert_eq "guidance-base-blob-winner" "yes" "${got_g}"
case "$(cat "${bldir}/tmp/muse-guidance.md" 2>/dev/null)" in *"CLAUDE.md (trusted"*) got_g="trusted";; *) got_g="untrusted";; esac
assert_eq "guidance-base-blob-trusted" "trusted" "${got_g}"
case "$(cat "${bldir}/tmp/muse-guidance.md" 2>/dev/null)" in *"inner.txt"*) got_g="tree";; *) got_g="no-tree";; esac
assert_eq "guidance-base-tree-not-trusted" "no-tree" "${got_g}"
rm -rf "${bldir}"
# Guidance labels must keep newline vs underscore scopes distinct.
ladir="$(mktemp -d)"
mkdir -p "${ladir}/tmp" "${ladir}/ws/a_b"
python3 -c "import os; os.makedirs('${ladir}/ws/' + 'a' + chr(10) + 'b', exist_ok=True)"
printf 'underscore-rule\n' > "${ladir}/ws/a_b/AGENTS.md"
python3 -c "open('${ladir}/ws/' + 'a' + chr(10) + 'b/AGENTS.md','w').write('newline-rule\n')"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${ladir}/tmp/muse-vars.env"
python3 -c "import json; print(json.dumps([{'filename': 'a_b/f.ts'}, {'filename': 'a' + chr(10) + 'b/f.ts'}]))" > "${ladir}/tmp/muse-files.json"
(cd "${ladir}/ws" && RUNNER_TEMP="${ladir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1
uline="$(grep -a 'underscore-rule' "${ladir}/tmp/muse-guidance.md" >/dev/null 2>&1 && grep -a -B2 'underscore-rule' "${ladir}/tmp/muse-guidance.md" | head -n 3 | grep -a 'a_b' >/dev/null && echo ok || echo bad)"
assert_eq "guidance-label-underscore" "ok" "${uline}"
case "$(grep -a 'AGENTS.md' "${ladir}/tmp/muse-guidance.md" 2>/dev/null)" in *'a\nb/AGENTS.md'*) got_g="escaped";; *) got_g="collapsed";; esac
assert_eq "guidance-label-newline-escaped" "escaped" "${got_g}"
rm -rf "${ladir}"
# An over-300-char guidance candidate fails closed instead of
# collapsing two long-prefix labels by slicing.
lodir="$(mktemp -d)"
mkdir -p "${lodir}/tmp" "${lodir}/ws"
longa="$(python3 -c "print('a' * 140)")"
longb="$(python3 -c "print('b' * 170)")"
longdir="${longa}/${longb}"
mkdir -p "${lodir}/ws/${longdir}"
printf 'long-rule\n' > "${lodir}/ws/${longdir}/AGENTS.md"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_DEFAULT_BRANCH=main\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
} > "${lodir}/tmp/muse-vars.env"
python3 -c "import json; print(json.dumps([{'filename': 'a'*140 + '/' + 'b'*170 + '/f.ts'}]))" > "${lodir}/tmp/muse-files.json"
if (cd "${lodir}/ws" && RUNNER_TEMP="${lodir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${guidance_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "guidance-long-label-fails-closed" "nonzero" "${got_rc}"
rm -rf "${lodir}"
# Gitlink targets are recorded from tree objects, not the diff hunk,
# so they survive the 60 KB truncation.
gldir="$(mktemp -d)"
mkdir -p "${gldir}/repo"
git -C "${gldir}/repo" init -q 2>/dev/null
printf 'x\n' > "${gldir}/repo/f.txt"
git -C "${gldir}/repo" add f.txt 2>/dev/null
git -C "${gldir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
glbase="$(git -C "${gldir}/repo" rev-parse HEAD 2>/dev/null)"
glhead="$(python3 -c "
import subprocess
repo='${gldir}/repo'
subprocess.check_call(['git','-C',repo,'update-index','--add','--cacheinfo','160000,${glbase},sub'])
tree=subprocess.check_output(['git','-C',repo,'write-tree']).strip()
head=subprocess.check_output(['git','-C',repo,'-c','user.email=t@t','-c','user.name=t','commit-tree',tree,'-p','${glbase}','-m','head']).strip()
print(head.decode())
")"
printf '[{"filename":"sub"},{"filename":"f.txt"}]' > "${gldir}/files.json"
got="$(changed_gitlinks "${gldir}/files.json" "${glhead}" "${glbase}" "${gldir}/repo" 50)"
assert_eq "gitlinks-head-recorded" "sub -> head ${glbase}" "${got}"
printf '[{"filename":"newsub","previous_filename":"sub"}]' > "${gldir}/files2.json"
# Rename-away fixture needs a head without sub: reuse base as head (no sub change is not in its tree, so construct via files2 against base..base gives no head, base only)
got="$(changed_gitlinks "${gldir}/files.json" "${glbase}" "${glbase}" "${gldir}/repo" 50)"
assert_eq "gitlinks-unchanged-none" "" "${got}"
rm -rf "${gldir}"
# Mode-only changes are recorded from trees, past the diff cap.
mdir="$(mktemp -d)"
mkdir -p "${mdir}/repo"
git -C "${mdir}/repo" init -q 2>/dev/null
printf 'echo hi\n' > "${mdir}/repo/run.sh"
git -C "${mdir}/repo" add run.sh 2>/dev/null
git -C "${mdir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
mbase="$(git -C "${mdir}/repo" rev-parse HEAD 2>/dev/null)"
mhead="$(python3 -c "
import subprocess
repo='${mdir}/repo'
blob=subprocess.check_output(['git','-C',repo,'hash-object','-w','run.sh']).strip()
subprocess.check_call(['git','-C',repo,'update-index','--add','--cacheinfo','100755,' + blob.decode() + ',run.sh'])
tree=subprocess.check_output(['git','-C',repo,'write-tree']).strip()
head=subprocess.check_output(['git','-C',repo,'-c','user.email=t@t','-c','user.name=t','commit-tree',tree,'-p','${mbase}','-m','head']).strip()
print(head.decode())
")"
printf '[{"filename":"run.sh"}]' > "${mdir}/files.json"
got="$(changed_modes "${mdir}/files.json" "${mhead}" "${mbase}" "${mdir}/repo" 50)"
assert_eq "modes-change-recorded" "run.sh: base 100644, head 100755" "${got}"
got="$(changed_modes "${mdir}/files.json" "${mbase}" "${mbase}" "${mdir}/repo" 50)"
assert_eq "modes-unchanged-none" "" "${got}"
# Tab in a filename: fields must not split on the filename's own tab.
tfdir="$(mktemp -d)"
mkdir -p "${tfdir}/repo"
git -C "${tfdir}/repo" init -q 2>/dev/null
python3 -c "open('${tfdir}/repo/with' + chr(9) + 'tab.sh', 'w').write('echo hi\n')"
git -C "${tfdir}/repo" add -A 2>/dev/null
git -C "${tfdir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
tfbase="$(git -C "${tfdir}/repo" rev-parse HEAD 2>/dev/null)"
tfhead="$(python3 -c "
import subprocess, json
repo='${tfdir}/repo'
name='with' + chr(9) + 'tab.sh'
blob=subprocess.check_output(['git','-C',repo,'hash-object','-w',name]).strip()
subprocess.check_call(['git','-C',repo,'update-index','--add','--cacheinfo','100755,' + blob.decode() + ',' + name])
tree=subprocess.check_output(['git','-C',repo,'write-tree']).strip()
head=subprocess.check_output(['git','-C',repo,'-c','user.email=t@t','-c','user.name=t','commit-tree',tree,'-p','${tfbase}','-m','head']).strip()
print(head.decode())
")"
python3 -c "import json; json.dump([{'filename': 'with' + chr(9) + 'tab.sh'}], open('${tfdir}/files.json','w'))"
got="$(changed_modes "${tfdir}/files.json" "${tfhead}" "${tfbase}" "${tfdir}/repo" 50)"
assert_eq "modes-tab-filename-intact" "$(printf 'with\ttab.sh: base 100644, head 100755')" "${got}"
rm -rf "${tfdir}"
rm -rf "${mdir}"

# --- diff.sh --text vs .gitattributes -diff suppression (script level) ---
# A -diff rule would otherwise emit a "Binary files differ" placeholder:
# the removed-lines supplement loses the deleted code while diff_failed
# stays false and a blind review posts as success.
ddir="$(mktemp -d)"
mkdir -p "${ddir}/tmp" "${ddir}/repo"
git -C "${ddir}/repo" init -q 2>/dev/null
printf 'one\nremoved_marker_line\nthree\n' > "${ddir}/repo/app.js"
git -C "${ddir}/repo" add app.js 2>/dev/null
git -C "${ddir}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
dbase="$(git -C "${ddir}/repo" rev-parse HEAD 2>/dev/null)"
printf '*.js -diff\n' > "${ddir}/repo/.gitattributes"
printf 'one\nthree\nfour\n' > "${ddir}/repo/app.js"
git -C "${ddir}/repo" add app.js .gitattributes 2>/dev/null
git -C "${ddir}/repo" -c user.email=t@t -c user.name=t commit -qm head 2>/dev/null
dhead="$(git -C "${ddir}/repo" rev-parse HEAD 2>/dev/null)"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_FILES_FAILED=false\n'
  printf 'MUSE_FILES_SOURCE=local\n'
  printf 'MUSE_MERGE_BASE=%s\n' "${dbase}"
  printf 'MUSE_TOTAL_FILES=2\n'
  printf 'MUSE_BASE_SHA=%s\n' "${dbase}"
} > "${ddir}/tmp/muse-vars.env"
: > "${ddir}/tmp/out.txt"
diff_script="${SCRIPT_DIR}/diff.sh"
(cd "${ddir}/repo" && RUNNER_TEMP="${ddir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_OUTPUT="${ddir}/tmp/out.txt" HEAD_SHA_EVENT="${dhead}" GITHUB_REPOSITORY="t/t" GH_TOKEN="fake" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${ddir}/tmp/muse-removed.txt" 2>/dev/null)" in *"removed_marker_line"*) got_d="yes";; *) got_d="no";; esac
assert_eq "diff-text-removed-lines" "yes" "${got_d}"
case "$(cat "${ddir}/tmp/muse.diff" 2>/dev/null)" in *"Binary files"*) got_d="binary";; *"removed_marker_line"*) got_d="text";; *) got_d="other";; esac
assert_eq "diff-text-not-binary" "text" "${got_d}"
mkdir -p "${ddir}/repo2"
git -C "${ddir}/repo2" init -q 2>/dev/null
python3 -c "print('\n'.join('line%06d' % i for i in range(3000)))" > "${ddir}/repo2/big.txt"
git -C "${ddir}/repo2" add big.txt 2>/dev/null
git -C "${ddir}/repo2" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
dbase2="$(git -C "${ddir}/repo2" rev-parse HEAD 2>/dev/null)"
rm "${ddir}/repo2/big.txt"
git -C "${ddir}/repo2" add -A 2>/dev/null
git -C "${ddir}/repo2" -c user.email=t@t -c user.name=t commit -qm head 2>/dev/null
dhead2="$(git -C "${ddir}/repo2" rev-parse HEAD 2>/dev/null)"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_FILES_FAILED=false\n'
  printf 'MUSE_FILES_SOURCE=local\n'
  printf 'MUSE_MERGE_BASE=%s\n' "${dbase2}"
  printf 'MUSE_TOTAL_FILES=1\n'
  printf 'MUSE_BASE_SHA=%s\n' "${dbase2}"
} > "${ddir}/tmp/muse-vars.env"
if (cd "${ddir}/repo2" && RUNNER_TEMP="${ddir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_OUTPUT="${ddir}/tmp/out.txt" HEAD_SHA_EVENT="${dhead2}" GITHUB_REPOSITORY="t/t" GH_TOKEN="fake" bash "${diff_script}") >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "diff-removed-cap-fails-closed" "nonzero" "${got_rc}"
rm -rf "${ddir}"
# Removed-line EOF marker: adding only a final newline must keep the
# `\ No newline at end of file` marker beside the removed line, or the
# supplement is identical to removing a newline-terminated line.
eod="$(mktemp -d)"
mkdir -p "${eod}/tmp" "${eod}/repo"
git -C "${eod}/repo" init -q 2>/dev/null
printf 'keep' > "${eod}/repo/eol.txt"
git -C "${eod}/repo" add eol.txt 2>/dev/null
git -C "${eod}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
eobase="$(git -C "${eod}/repo" rev-parse HEAD 2>/dev/null)"
printf 'keep\n' > "${eod}/repo/eol.txt"
git -C "${eod}/repo" add eol.txt 2>/dev/null
git -C "${eod}/repo" -c user.email=t@t -c user.name=t commit -qm head 2>/dev/null
eohead="$(git -C "${eod}/repo" rev-parse HEAD 2>/dev/null)"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_FILES_FAILED=false\n'
  printf 'MUSE_FILES_SOURCE=local\n'
  printf 'MUSE_MERGE_BASE=%s\n' "${eobase}"
  printf 'MUSE_TOTAL_FILES=1\n'
  printf 'MUSE_BASE_SHA=%s\n' "${eobase}"
} > "${eod}/tmp/muse-vars.env"
: > "${eod}/tmp/out.txt"
(cd "${eod}/repo" && RUNNER_TEMP="${eod}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_OUTPUT="${eod}/tmp/out.txt" HEAD_SHA_EVENT="${eohead}" GITHUB_REPOSITORY="t/t" GH_TOKEN="fake" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${eod}/tmp/muse-removed.txt" 2>/dev/null)" in *'-keep'*) got_d="line";; *) got_d="missing";; esac
assert_eq "diff-removed-eof-line" "line" "${got_d}"
case "$(cat "${eod}/tmp/muse-removed.txt" 2>/dev/null)" in *'No newline at end of file'*) got_d="marker";; *) got_d="missing";; esac
assert_eq "diff-removed-eof-marker" "marker" "${got_d}"
rm -rf "${eod}"

# --- diff.sh size-limited compare diff fails closed (script level) ---
# A successful compare response at GitHub's 20,000-line / 1 MB / 500 KB
# limits can silently omit deleted tail content; it must not post as a
# complete review. Stub gh serves the compare diff from a fixture.
xdir="$(mktemp -d)"
mkdir -p "${xdir}/tmp" "${xdir}/bin" "${xdir}/repo"
cat > "${xdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
cat "${GH_STUB_DIFF}"
STUB
chmod +x "${xdir}/bin/gh"
python3 -c "
print('diff --git a/f.txt b/f.txt')
print('--- a/f.txt')
print('+++ b/f.txt')
print('@@ -1 +1 @@')
for i in range(20010):
    print('+line%06d' % i)
" > "${xdir}/big.diff"
printf 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n+ok\n' > "${xdir}/small.diff"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_FILES_FAILED=false\n'
  printf 'MUSE_FILES_SOURCE=api\n'
  printf 'MUSE_TOTAL_FILES=1\n'
  printf 'MUSE_BASE_SHA=%s\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
} > "${xdir}/tmp/muse-vars.env"
: > "${xdir}/tmp/out.txt"
diff_script="${SCRIPT_DIR}/diff.sh"
(cd "${xdir}/repo" && GH_STUB_DIFF="${xdir}/big.diff" PATH="${xdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" HEAD_SHA_EVENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" GITHUB_OUTPUT="${xdir}/tmp/out.txt" RUNNER_TEMP="${xdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${xdir}/tmp/out.txt")" in *"diff_failed=true"*) got_x="failed";; *) got_x="ok";; esac
assert_eq "diff-compare-line-limit-fails-closed" "failed" "${got_x}"
: > "${xdir}/tmp/out.txt"
(cd "${xdir}/repo" && GH_STUB_DIFF="${xdir}/small.diff" PATH="${xdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" HEAD_SHA_EVENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" GITHUB_OUTPUT="${xdir}/tmp/out.txt" RUNNER_TEMP="${xdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${xdir}/tmp/out.txt")" in *"diff_failed=false"*) got_x="ok";; *) got_x="failed";; esac
assert_eq "diff-compare-small-ok" "ok" "${got_x}"
python3 -c "
print('diff --git a/f.txt b/f.txt')
print('--- a/f.txt')
print('+++ b/f.txt')
print('@@ -1 +1 @@')
for i in range(6000):
    print('+' + 'é' * 60)
" > "${xdir}/wide.diff"
: > "${xdir}/tmp/out.txt"
(cd "${xdir}/repo" && GH_STUB_DIFF="${xdir}/wide.diff" PATH="${xdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" HEAD_SHA_EVENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" GITHUB_OUTPUT="${xdir}/tmp/out.txt" RUNNER_TEMP="${xdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${xdir}/tmp/out.txt")" in *"diff_failed=true"*) got_x="failed";; *) got_x="ok";; esac
assert_eq "diff-compare-byte-limit-fails-closed" "failed" "${got_x}"
printf 'diff --git a/img.png b/img.png\ndeleted file mode 100644\nBinary files a/img.png and /dev/null differ\n' > "${xdir}/bin.diff"
: > "${xdir}/tmp/out.txt"
(cd "${xdir}/repo" && GH_STUB_DIFF="${xdir}/bin.diff" PATH="${xdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" HEAD_SHA_EVENT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" GITHUB_OUTPUT="${xdir}/tmp/out.txt" RUNNER_TEMP="${xdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${diff_script}") >/dev/null 2>&1
case "$(cat "${xdir}/tmp/out.txt")" in *"diff_failed=true"*) got_x="failed";; *) got_x="ok";; esac
assert_eq "diff-compare-binary-fails-closed" "failed" "${got_x}"
rm -rf "${xdir}"

# --- post.sh over-budget fallback drops inline threads (script level) ---
# Stub gh: the live-PR lookup prints the @tsv row post.sh expects, review
# lists are empty, and POST captures its --input payload for inspection.
# 40 findings with 4000-char titles overflow even the compact render, so
# post.sh must fall back — with NO inline comments attached.
pdir="$(mktemp -d)"
mkdir -p "${pdir}/tmp" "${pdir}/bin"
cat > "${pdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${pdir}/bin/gh"
psha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
pbsha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${pdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${pdir}/tmp/muse-files.json"
python3 -c "
import json
t = 'T' * 4000
fs = [{'path': 'a.ts', 'line': (i % 50) + 1, 'severity': 'low', 'title': t, 'body': 'b'} for i in range(40)]
print(json.dumps({'verdict': 'v', 'findings': fs, 'next_steps': []}))
" > "${pdir}/tmp/review.json"
post_script="${SCRIPT_DIR}/post.sh"
GH_STUB_CAPTURE="${pdir}/capture.json" GH_STUB_HEAD="${psha}" GH_STUB_BASE="${pbsha}" \
PATH="${pdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${psha}" BASE_SHA="${pbsha}" HEAD_SHA_EVENT="${psha}" BASE_SHA_EVENT="${pbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${pdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${pdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
got="$(jq -r '(.comments // []) | length' "${pdir}/capture.json" 2>/dev/null || echo "missing")"
assert_eq "post-budget-fallback-no-inline" "0" "${got}"
case "$(jq -r '.body // ""' "${pdir}/capture.json" 2>/dev/null)" in *"muse-fallback:v1"*"exceeds the 60000-byte post budget"*) got_p="yes";; *) got_p="no";; esac
assert_eq "post-budget-fallback-tagged" "yes" "${got_p}"
rm -rf "${pdir}"

# --- post.sh NUL-bearing findings route to fallback (script level) ---
# Defense in depth for the run-step NUL strip: a decoded NUL reaching this
# keyless step would be discarded by Bash variable extraction, rejoining a
# split credential. Stub gh like the budget test above; the review body
# carries the fake key split by U+0000, so a vulnerable post would publish
# the rejoined key while the guarded post must fall back with no inline
# comments and no contiguous key anywhere in the payload.
ndir="$(mktemp -d)"
mkdir -p "${ndir}/tmp" "${ndir}/bin"
cat > "${ndir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${ndir}/bin/gh"
nsha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
nbsha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${ndir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${ndir}/tmp/muse-files.json"
python3 -c "
import json
body = 'leak fake.live/key+abc' + chr(0) + '=123 end'
print(json.dumps({'verdict': 'v', 'findings': [{'path': 'a.ts', 'line': 1, 'severity': 'low', 'title': 't', 'body': body}], 'next_steps': []}))
" > "${ndir}/tmp/review.json"
post_script="${SCRIPT_DIR}/post.sh"
GH_STUB_CAPTURE="${ndir}/capture.json" GH_STUB_HEAD="${nsha}" GH_STUB_BASE="${nbsha}" \
PATH="${ndir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${nsha}" BASE_SHA="${nbsha}" HEAD_SHA_EVENT="${nsha}" BASE_SHA_EVENT="${nbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${ndir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${ndir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
got="$(jq -r '(.comments // []) | length' "${ndir}/capture.json" 2>/dev/null || echo "missing")"
assert_eq "post-nul-no-inline" "0" "${got}"
case "$(jq -r '.body // ""' "${ndir}/capture.json" 2>/dev/null)" in *"muse-fallback:v1"*) got_n="fallback";; *) got_n="review";; esac
assert_eq "post-nul-fallback-tagged" "fallback" "${got_n}"
case "$(cat "${ndir}/capture.json" 2>/dev/null)" in *"fake.live/key+abc=123"*) got_n="leaked";; *) got_n="clean";; esac
assert_eq "post-nul-no-rejoined-key" "clean" "${got_n}"
rm -rf "${ndir}"

# --- post.sh redact again after image stripping (script level) ---
# A pattern secret split by a removable image token must not rejoin
# when strip_images deletes the token: the final redaction pass runs
# after every byte-removing filter.
idir2="$(mktemp -d)"
mkdir -p "${idir2}/tmp" "${idir2}/bin"
cat > "${idir2}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${idir2}/bin/gh"
isha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ibsha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${idir2}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${idir2}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"x gh![](https://example.invalid/i)p_abc123XYZ y"}],"next_steps":[]}' > "${idir2}/tmp/review.json"
post_script="${SCRIPT_DIR}/post.sh"
GH_STUB_CAPTURE="${idir2}/capture.json" GH_STUB_HEAD="${isha}" GH_STUB_BASE="${ibsha}" \
PATH="${idir2}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${isha}" BASE_SHA="${ibsha}" HEAD_SHA_EVENT="${isha}" BASE_SHA_EVENT="${ibsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${idir2}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${idir2}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(cat "${idir2}/capture.json" 2>/dev/null)" in *"ghp_abc123XYZ"*) got_i="leaked";; *) got_i="clean";; esac
assert_eq "post-img-split-not-rejoined" "clean" "${got_i}"
case "$(cat "${idir2}/capture.json" 2>/dev/null)" in *"[REDACTED]"*) got_i="redacted";; *) got_i="missing";; esac
assert_eq "post-img-split-redacted" "redacted" "${got_i}"
rm -rf "${idir2}"

# --- post.sh HTML-comment split cannot reconstruct (script level) ---
# A credential split by a render-hidden HTML comment must not visibly
# rejoin when posted: the comment is replaced by a nonempty separator
# before the final redaction.
hdir="$(mktemp -d)"
mkdir -p "${hdir}/tmp" "${hdir}/bin"
cat > "${hdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${hdir}/bin/gh"
hsha="cccccccccccccccccccccccccccccccccccccccc"
hbsha="dddddddddddddddddddddddddddddddddddddddd"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${hdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${hdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"x ghp_left<!-- hidden -->right y and ghp_ab&#99;d and ghp_xy<span></span>zw and ghp_qq[]()rr and ghp_zz*A*ww and ghp_mm[A](https://example.invalid)nn and ghp_pp[A]qq and ghp_rs\\.tu and ghp_oo[*A*]pp and ghp_ab` C `de and ghp_fg<?x?>hi and ghp_st\u200btuv and use `a*b` ok and MUSEC[S]6c656674417269676874Z tail\n\n[A]: https://example.invalid/d\n[*A*]: https://example.invalid/e\n[S]: https://example.invalid/g"}],"next_steps":[]}' > "${hdir}/tmp/review.json"
GH_STUB_CAPTURE="${hdir}/capture.json" GH_STUB_HEAD="${hsha}" GH_STUB_BASE="${hbsha}" \
PATH="${hdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${hsha}" BASE_SHA="${hbsha}" HEAD_SHA_EVENT="${hsha}" BASE_SHA_EVENT="${hbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${hdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${hdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_leftright"*) got_h="rejoined";; *) got_h="clean";; esac
assert_eq "post-html-split-not-rejoined" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"<!-- hidden -->"*) got_h="kept";; *) got_h="removed";; esac
assert_eq "post-html-comment-removed" "removed" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_abcd"*) got_h="rejoined";; *) got_h="clean";; esac
assert_eq "post-entity-split-not-rejoined" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"&amp;#99;"*) got_h="neutralized";; *) got_h="raw";; esac
assert_eq "post-entity-neutralized" "neutralized" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_xyzw"*) got_h="rejoined";; *) got_h="clean";; esac
assert_eq "post-tag-split-not-rejoined" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"[HTML removed]"*) got_h="separated";; *) got_h="raw";; esac
assert_eq "post-tag-separated" "separated" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"<sub>Useful?"*) got_h="kept";; *) got_h="eaten";; esac
assert_eq "post-footer-sub-kept" "kept" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_qqrr"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-empty-link-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"[]()"*) got_h="kept";; *) got_h="removed";; esac
assert_eq "post-empty-link-removed" "removed" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_zzAww"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-emphasis-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_zz*A*ww"*) got_h="raw";; *) got_h="stripped";; esac
assert_eq "post-emphasis-markers-stripped" "stripped" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_mmAnn"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-link-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"[REDACTED] (https://example.invalid)"*) got_h="canon";; *) got_h="raw";; esac
assert_eq "post-link-canonicalized" "canon" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_ppAqq"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-shortcut-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"example.invalid/d"*) got_h="kept";; *) got_h="removed";; esac
assert_eq "post-link-def-removed" "removed" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_rs.tu"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-mdesc-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_ooApp"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-canon-marker-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"*A*"*) got_h="raw";; *) got_h="stripped";; esac
assert_eq "post-canon-marker-stripped" "stripped" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_abCde"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-codespan-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_fghi"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-pi-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *'<?x?>'*) got_h="raw";; *) got_h="stripped";; esac
assert_eq "post-pi-stripped" "stripped" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"ghp_sttuv"*) got_h="visible";; *) got_h="clean";; esac
assert_eq "post-zerowidth-split-not-visible" "clean" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *$'\xe2\x80\x8b'*) got_h="raw";; *) got_h="stripped";; esac
assert_eq "post-zerowidth-stripped" "stripped" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *'`a*b`'*) got_h="kept";; *) got_h="mangled";; esac
assert_eq "post-inline-code-preserved" "kept" "${got_h}"
case "$(cat "${hdir}/capture.json" 2>/dev/null)" in *"leftAright"*) got_h="forged";; *) got_h="safe";; esac
assert_eq "post-sentinel-not-forged" "safe" "${got_h}"
rm -rf "${hdir}"

# --- post.sh non-string next_steps routes to fallback (script level) ---
# clean.jq drops non-string next_steps; posting the cleaned review
# under the success marker would silently lose part of the output and
# dedupe would block recovery, so any dropped step is malformed output.
xdir="$(mktemp -d)"
mkdir -p "${xdir}/tmp" "${xdir}/bin"
cat > "${xdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${xdir}/bin/gh"
xsha="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
xbsha="ffffffffffffffffffffffffffffffffffffffff"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${xdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${xdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"b"}],"next_steps":["ok",42]}' > "${xdir}/tmp/review.json"
GH_STUB_CAPTURE="${xdir}/capture.json" GH_STUB_HEAD="${xsha}" GH_STUB_BASE="${xbsha}" \
PATH="${xdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${xsha}" BASE_SHA="${xbsha}" HEAD_SHA_EVENT="${xsha}" BASE_SHA_EVENT="${xbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${xdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${xdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(cat "${xdir}/capture.json" 2>/dev/null)" in *"muse-fallback:v1"*) got_x="fallback";; *) got_x="review";; esac
assert_eq "post-bad-next-step-fallback" "fallback" "${got_x}"
got="$(jq -r '(.comments // []) | length' "${xdir}/capture.json" 2>/dev/null || echo "missing")"
assert_eq "post-bad-next-step-no-inline" "0" "${got}"
rm -rf "${xdir}"

# --- post.sh revalidates immediately before POST (script level) ---
# The stub serves the captured head on the entry gate and a moved head
# on the next pull lookup: the pre-POST revalidation must skip the post
# entirely (no capture) instead of attaching findings to the old SHA.
rdir="$(mktemp -d)"
mkdir -p "${rdir}/tmp" "${rdir}/bin"
cat > "${rdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *)
    n="$(cat "${GH_STUB_STATE}" 2>/dev/null || echo 0)"; n=$((n + 1)); printf '%s' "${n}" > "${GH_STUB_STATE}"
    if (( n >= 2 )); then
      printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD2}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}"
    else
      printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}"
    fi
    ;;
esac
STUB
chmod +x "${rdir}/bin/gh"
rsha="1212121212121212121212121212121212121212"
rsha2="3434343434343434343434343434343434343434"
rbsha="5656565656565656565656565656565656565656"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${rdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${rdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"b"}],"next_steps":[]}' > "${rdir}/tmp/review.json"
printf '0' > "${rdir}/state"
GH_STUB_CAPTURE="${rdir}/capture.json" GH_STUB_STATE="${rdir}/state" GH_STUB_HEAD="${rsha}" GH_STUB_HEAD2="${rsha2}" GH_STUB_BASE="${rbsha}" \
PATH="${rdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${rsha}" BASE_SHA="${rbsha}" HEAD_SHA_EVENT="${rsha}" BASE_SHA_EVENT="${rbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${rdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${rdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
if [[ -f "${rdir}/capture.json" ]]; then got_r="posted"; else got_r="blocked"; fi
assert_eq "post-revalidate-blocks-stale" "blocked" "${got_r}"
rm -rf "${rdir}"

# --- post.sh out-of-range line renders unverified (script level) ---
vdir="$(mktemp -d)"
mkdir -p "${vdir}/tmp" "${vdir}/bin"
cat > "${vdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${vdir}/bin/gh"
vsha="7878787878787878787878787878787878787878"
vbsha="9090909090909090909090909090909090909090"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${vdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${vdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":99,"severity":"low","title":"far","body":"b"}],"next_steps":[]}' > "${vdir}/tmp/review.json"
GH_STUB_CAPTURE="${vdir}/capture.json" GH_STUB_HEAD="${vsha}" GH_STUB_BASE="${vbsha}" \
PATH="${vdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${vsha}" BASE_SHA="${vbsha}" HEAD_SHA_EVENT="${vsha}" BASE_SHA_EVENT="${vbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${vdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${vdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(cat "${vdir}/capture.json" 2>/dev/null)" in *"line not in visible diff — unverified"*) got_v="marked";; *) got_v="plain";; esac
assert_eq "post-outofrange-unverified" "marked" "${got_v}"
rm -rf "${vdir}"

# --- post.sh truncation re-sanitizes exposed mentions (script level) ---
# A code span whose closing backtick falls past the 6000-byte cutoff is
# restored whole and then truncated open; the exposed @mention inside
# must be broken again after truncation.
tdir="$(mktemp -d)"
mkdir -p "${tdir}/tmp" "${tdir}/bin"
cat > "${tdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*) printf '[]\n' ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${tdir}/bin/gh"
tsha="abababababababababababababababababababab"
tbsha="cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,50 @@\n+x\n' > "${tdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${tdir}/tmp/muse-files.json"
python3 -c "
import json
body = '\`@octocat' + 'x' * 6100 + '\`'
json.dump({'verdict': 'v', 'findings': [{'path': 'a.ts', 'line': 1, 'severity': 'low', 'title': 't', 'body': body}], 'next_steps': []}, open('${tdir}/tmp/review.json', 'w'))
"
GH_STUB_CAPTURE="${tdir}/capture.json" GH_STUB_HEAD="${tsha}" GH_STUB_BASE="${tbsha}" \
PATH="${tdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${tsha}" BASE_SHA="${tbsha}" HEAD_SHA_EVENT="${tsha}" BASE_SHA_EVENT="${tbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${tdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${tdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(cat "${tdir}/capture.json" 2>/dev/null)" in *"@"$'\xe2\x80\x8b'"octocat"*) got_t="broken";; *) got_t="active";; esac
assert_eq "post-trunc-mention-broken" "broken" "${got_t}"
rm -rf "${tdir}"

# --- collect.sh live default-base eligibility (script level) ---
# A rerun after a base retarget keeps the event-time job gate fooled; the
# live recheck must stop custom-base runs before evidence collection.
cdir="$(mktemp -d)"
mkdir -p "${cdir}/tmp" "${cdir}/bin" "${cdir}/repo"
cat > "${cdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *"/files"*) printf '[]\n' ;;
  *"/pulls/"*) cat "${GH_STUB_PR_JSON}" ;;
  *) printf '{}\n' ;;
esac
STUB
chmod +x "${cdir}/bin/gh"
git -C "${cdir}/repo" init -q 2>/dev/null
chead="cccccccccccccccccccccccccccccccccccccccc"
cbase="dddddddddddddddddddddddddddddddddddddddd"
collect_script="${SCRIPT_DIR}/collect.sh"
python3 -c "
import json, sys
base = sys.argv[1]
print(json.dumps({'head': {'sha': '${chead}', 'ref': 'feat'}, 'base': {'ref': base, 'sha': '${cbase}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" "stacked-base" > "${cdir}/pr-custom.json"
: > "${cdir}/tmp/out.txt"
(cd "${cdir}/repo" && GH_STUB_PR_JSON="${cdir}/pr-custom.json" PATH="${cdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${chead}" GITHUB_OUTPUT="${cdir}/tmp/out.txt" RUNNER_TEMP="${cdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
case "$(cat "${cdir}/tmp/out.txt")" in *"should_review=false"*) got_c="skip";; *) got_c="review";; esac
assert_eq "collect-custom-base-skips" "skip" "${got_c}"
assert_eq "collect-custom-base-stop" "MUSE_STOP=1" "$(cat "${cdir}/tmp/muse-vars.env" 2>/dev/null)"
python3 -c "
import json, sys
base = sys.argv[1]
print(json.dumps({'head': {'sha': '${chead}', 'ref': 'feat'}, 'base': {'ref': base, 'sha': '${cbase}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" "main" > "${cdir}/pr-main.json"
: > "${cdir}/tmp/out.txt"
(cd "${cdir}/repo" && GH_STUB_PR_JSON="${cdir}/pr-main.json" PATH="${cdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${chead}" GITHUB_OUTPUT="${cdir}/tmp/out.txt" RUNNER_TEMP="${cdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
case "$(cat "${cdir}/tmp/out.txt")" in *"should_review=true"*) got_c="review";; *) got_c="skip";; esac
assert_eq "collect-default-base-reviews" "review" "${got_c}"
case "$(cat "${cdir}/tmp/muse-vars.env" 2>/dev/null)" in *"MUSE_FILES_FAILED=true"*) got_c="fallback";; *) got_c="complete";; esac
assert_eq "collect-base-unavailable-fallback" "fallback" "${got_c}"
mkdir -p "${cdir}/repo2"
git -C "${cdir}/repo2" init -q 2>/dev/null
printf 'base\n' > "${cdir}/repo2/f.txt"
git -C "${cdir}/repo2" add f.txt 2>/dev/null
git -C "${cdir}/repo2" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
cbase2="$(git -C "${cdir}/repo2" rev-parse HEAD 2>/dev/null)"
printf 'head\n' >> "${cdir}/repo2/f.txt"
git -C "${cdir}/repo2" add f.txt 2>/dev/null
git -C "${cdir}/repo2" -c user.email=t@t -c user.name=t commit -qm head 2>/dev/null
chead2="$(git -C "${cdir}/repo2" rev-parse HEAD 2>/dev/null)"
git -C "${cdir}/repo2" remote add origin "file://${cdir}/repo2" 2>/dev/null
python3 -c "
import json
print(json.dumps({'head': {'sha': '${chead2}', 'ref': 'feat'}, 'base': {'ref': 'main', 'sha': '${cbase2}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" > "${cdir}/pr-live.json"
: > "${cdir}/tmp/out.txt"
(cd "${cdir}/repo2" && GH_STUB_PR_JSON="${cdir}/pr-live.json" PATH="${cdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${chead2}" GITHUB_OUTPUT="${cdir}/tmp/out.txt" RUNNER_TEMP="${cdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
case "$(cat "${cdir}/tmp/muse-vars.env" 2>/dev/null)" in *"MUSE_BASE_AVAILABLE=true"*"MUSE_FILES_FAILED=false"*) got_c="complete";; *) got_c="fallback";; esac
assert_eq "collect-base-available-complete" "complete" "${got_c}"
rm -rf "${cdir}"

# --- prompt.sh symlink cap fails closed (script level) ---
# run.sh sweeps every symlink before the agent starts, so targets past
# the evidence cap are uninspectable anywhere: no successful marker.
sdir="$(mktemp -d)"
mkdir -p "${sdir}/tmp" "${sdir}/bin" "${sdir}/ws"
printf '#!/usr/bin/env bash\nprintf "[]\\n"\n' > "${sdir}/bin/gh"
chmod +x "${sdir}/bin/gh"
printf 'x' > "${sdir}/ws/a.ts"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_HEAD_SHA=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_HEAD_REF=feat\n'
  printf 'MUSE_PR_TITLE=t\n'
  printf 'MUSE_PR_BODY=\n'
  printf 'MUSE_FILES_NOTE=\n'
  printf 'MUSE_MANIFEST_NOTE=\n'
  printf 'MUSE_DIFF_NOTE=\n'
  printf 'MUSE_REMOVED_NOTE=\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
} > "${sdir}/tmp/muse-vars.env"
printf -- '- a.ts\n' > "${sdir}/tmp/muse-summary.txt"
printf 'a.ts\n' > "${sdir}/tmp/muse-manifest.txt"
printf 'diff\n' > "${sdir}/tmp/muse.diff"
: > "${sdir}/tmp/muse-removed.txt"
printf 'g\n' > "${sdir}/tmp/muse-guidance.md"
: > "${sdir}/tmp/out.txt"
prompt_script="${SCRIPT_DIR}/prompt.sh"
printf '[{"filename":"a.ts"}]' > "${sdir}/tmp/muse-files.json"
if PATH="${sdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${sdir}/tmp/out.txt" RUNNER_TEMP="${sdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${sdir}/ws" bash "${prompt_script}" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "prompt-symlink-small-ok" "0" "${got_rc}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *"closest to the changed file"*) got_p="yes";; *) got_p="no";; esac
assert_eq "prompt-guidance-precedence" "yes" "${got_p}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *"literal source backslash"*) got_p="yes";; *) got_p="no";; esac
assert_eq "prompt-escape-legend" "yes" "${got_p}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *"newline appears as"*) got_p="yes";; *) got_p="no";; esac
assert_eq "prompt-symlink-legend" "yes" "${got_p}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *"rename separator"*) got_p="yes";; *) got_p="no";; esac
assert_eq "prompt-manifest-legend" "yes" "${got_p}"
i=0
while (( i < 55 )); do
  ln -s "/target${i}" "${sdir}/ws/link${i}"
  i=$(( i + 1 ))
done
python3 -c "import json; print(json.dumps([{'filename': 'link%d' % i} for i in range(55)]))" > "${sdir}/tmp/muse-files.json"
if PATH="${sdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${sdir}/tmp/out.txt" RUNNER_TEMP="${sdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${sdir}/ws" bash "${prompt_script}" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "prompt-symlink-cap-fails-closed" "nonzero" "${got_rc}"
ln -s "$(python3 -c "print('t' * 600)")" "${sdir}/ws/longlink"
printf '[{"filename":"longlink"}]' > "${sdir}/tmp/muse-files.json"
if PATH="${sdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${sdir}/tmp/out.txt" RUNNER_TEMP="${sdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${sdir}/ws" bash "${prompt_script}" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "prompt-symlink-long-target-fails-closed" "nonzero" "${got_rc}"
# End-to-end: a non-UTF-8 target reaches the prompt byte-escaped instead
# of being silently shortened by UTF-8 filtering, and the run succeeds.
python3 -c "import os; os.symlink(b'bad' + bytes([255]) + b'target', b'${sdir}/ws/badutf')"
printf '[{"filename":"badutf"}]' > "${sdir}/tmp/muse-files.json"
if PATH="${sdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${sdir}/tmp/out.txt" RUNNER_TEMP="${sdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${sdir}/ws" bash "${prompt_script}" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "prompt-invalid-utf8-escaped-ok" "0" "${got_rc}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *'badutf -> head bad\xFFtarget'*) got_p="escaped";; *) got_p="altered";; esac
assert_eq "prompt-invalid-utf8-escaped" "escaped" "${got_p}"
# Removed-line evidence with non-UTF-8 bytes reaches the prompt escaped,
# not silently shortened: the head checkout cannot recover deletions.
printf 'gone bad\xffline\n' > "${sdir}/tmp/muse-removed.txt"
printf '[{"filename":"a.ts"}]' > "${sdir}/tmp/muse-files.json"
if PATH="${sdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${sdir}/tmp/out.txt" RUNNER_TEMP="${sdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${sdir}/ws" bash "${prompt_script}" >/dev/null 2>&1; then got_rc="0"; else got_rc="nonzero"; fi
assert_eq "prompt-removed-invalid-ok" "0" "${got_rc}"
case "$(cat "${sdir}/tmp/muse-prompt.md" 2>/dev/null)" in *'gone bad\xFFline'*) got_p="escaped";; *) got_p="altered";; esac
assert_eq "prompt-removed-invalid-escaped" "escaped" "${got_p}"
rm -rf "${sdir}"

# --- prompt.sh dedupe parse failure is unknown, not zero (script level) ---
# A successful reviews request whose body jq cannot parse must skip the
# billable run like a lookup failure, not proceed as "no review found".
qdir="$(mktemp -d)"
mkdir -p "${qdir}/tmp" "${qdir}/bin" "${qdir}/ws"
printf '#!/usr/bin/env bash\nprintf "not json\\n"\n' > "${qdir}/bin/gh"
chmod +x "${qdir}/bin/gh"
printf 'x' > "${qdir}/ws/a.ts"
{
  printf 'MUSE_STOP=0\n'
  printf 'MUSE_HEAD_SHA=%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  printf 'MUSE_BASE_REF=main\n'
  printf 'MUSE_HEAD_REF=feat\n'
  printf 'MUSE_PR_TITLE=t\n'
  printf 'MUSE_PR_BODY=\n'
  printf 'MUSE_FILES_NOTE=\n'
  printf 'MUSE_MANIFEST_NOTE=\n'
  printf 'MUSE_DIFF_NOTE=\n'
  printf 'MUSE_REMOVED_NOTE=\n'
  printf 'MUSE_BASE_AVAILABLE=false\n'
  printf 'MUSE_BASE_SHA_FULL=%s\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
} > "${qdir}/tmp/muse-vars.env"
printf -- '- a.ts\n' > "${qdir}/tmp/muse-summary.txt"
printf 'a.ts\n' > "${qdir}/tmp/muse-manifest.txt"
printf 'diff\n' > "${qdir}/tmp/muse.diff"
: > "${qdir}/tmp/muse-removed.txt"
printf 'g\n' > "${qdir}/tmp/muse-guidance.md"
: > "${qdir}/tmp/out.txt"
printf '[{"filename":"a.ts"}]' > "${qdir}/tmp/muse-files.json"
prompt_script="${SCRIPT_DIR}/prompt.sh"
PATH="${qdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" GITHUB_OUTPUT="${qdir}/tmp/out.txt" RUNNER_TEMP="${qdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" GITHUB_WORKSPACE="${qdir}/ws" bash "${prompt_script}" >/dev/null 2>&1
case "$(cat "${qdir}/tmp/out.txt")" in *"duplicate=true"*) got_q="skip";; *) got_q="run";; esac
assert_eq "prompt-dedupe-parse-failure-skips" "skip" "${got_q}"
rm -rf "${qdir}"

# --- post.sh comment-only retry after transient POST failure ---
# Stub gh counts POSTs, can fail the first, and can report the first
# attempt as landed (marker visible only after a POST was attempted).
rdir="$(mktemp -d)"
mkdir -p "${rdir}/tmp" "${rdir}/bin"
cat > "${rdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    n=0
    if [[ -f "${GH_STUB_COUNT}" ]]; then n="$(cat "${GH_STUB_COUNT}")"; fi
    n=$((n + 1))
    printf '%s' "${n}" > "${GH_STUB_COUNT}"
    : > "${GH_STUB_POSTED}"
    if [[ "${GH_STUB_FAIL_FIRST:-}" == "1" && "${n}" == "1" ]]; then
      printf 'transient failure\n' >&2
      exit 1
    fi
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*)
    if [[ -f "${GH_STUB_POSTED}" && -n "${GH_STUB_LANDED:-}" ]]; then
      cat "${GH_STUB_LANDED}"
    else
      printf '[]\n'
    fi
    ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${rdir}/bin/gh"
rsha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
rbsha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,5 @@\n+x\n' > "${rdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${rdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"v","findings":[{"path":"a.ts","line":0,"severity":"low","title":"t","body":"b"}],"next_steps":[]}' > "${rdir}/tmp/review.json"
post_script="${SCRIPT_DIR}/post.sh"
rm -f "${rdir}/count" "${rdir}/posted" "${rdir}/capture.json"
GH_STUB_COUNT="${rdir}/count" GH_STUB_POSTED="${rdir}/posted" GH_STUB_CAPTURE="${rdir}/capture.json" GH_STUB_HEAD="${rsha}" GH_STUB_BASE="${rbsha}" GH_STUB_FAIL_FIRST="1" GH_STUB_LANDED="" \
PATH="${rdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${rsha}" BASE_SHA="${rbsha}" HEAD_SHA_EVENT="${rsha}" BASE_SHA_EVENT="${rbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${rdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${rdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
assert_eq "post-retry-transient-count" "2" "$(cat "${rdir}/count" 2>/dev/null || echo missing)"
case "$(jq -r '.body // ""' "${rdir}/capture.json" 2>/dev/null)" in *"muse-fallback:v1"*) got_r="fallback";; *"## Verdict"*) got_r="review";; *) got_r="other";; esac
assert_eq "post-retry-transient-posts-review" "review" "${got_r}"
python3 -c "
import json
body = '<!-- muse-code-review sha:${rsha} base:bbbbbbbbbb -->\n## Muse code review (advisory)\n\nx'
print(json.dumps([{'user': {'login': 'github-actions[bot]'}, 'body': body}]))
" > "${rdir}/landed.json"
rm -f "${rdir}/count" "${rdir}/posted" "${rdir}/capture.json"
GH_STUB_COUNT="${rdir}/count" GH_STUB_POSTED="${rdir}/posted" GH_STUB_CAPTURE="${rdir}/capture.json" GH_STUB_HEAD="${rsha}" GH_STUB_BASE="${rbsha}" GH_STUB_FAIL_FIRST="1" GH_STUB_LANDED="${rdir}/landed.json" \
PATH="${rdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${rsha}" BASE_SHA="${rbsha}" HEAD_SHA_EVENT="${rsha}" BASE_SHA_EVENT="${rbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${rdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${rdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
assert_eq "post-retry-landed-no-double" "1" "$(cat "${rdir}/count" 2>/dev/null || echo missing)"
rm -f "${rdir}/count" "${rdir}/posted" "${rdir}/capture.json"
GH_STUB_COUNT="${rdir}/count" GH_STUB_POSTED="${rdir}/posted" GH_STUB_CAPTURE="${rdir}/capture.json" GH_STUB_HEAD="${rsha}" GH_STUB_BASE="${rbsha}" GH_STUB_FAIL_FIRST="" GH_STUB_LANDED="" GH_STUB_BASEREF="custom-base" GH_STUB_DEFAULT="main" \
PATH="${rdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${rsha}" BASE_SHA="${rbsha}" HEAD_SHA_EVENT="${rsha}" BASE_SHA_EVENT="${rbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${rdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${rdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
if [[ -f "${rdir}/count" ]]; then got_r="posted"; else got_r="skipped"; fi
assert_eq "post-retargeted-base-skips" "skipped" "${got_r}"
rm -rf "${rdir}"

# Summary-retry pointer must stay a nonempty separator: deleting
# " (see inline)" entirely would rejoin a secret the key-aware pass
# only saw in split halves (here an AIza token split around the
# pointer) inside the keyless retry payload.
kdir="$(mktemp -d)"
mkdir -p "${kdir}/tmp" "${kdir}/bin"
cp /dev/null "${kdir}/bin/.keep" 2>/dev/null || true
cat > "${kdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *" --method POST "*)
    n=0
    if [[ -f "${GH_STUB_COUNT}" ]]; then n="$(cat "${GH_STUB_COUNT}")"; fi
    n=$((n + 1))
    printf '%s' "${n}" > "${GH_STUB_COUNT}"
    : > "${GH_STUB_POSTED}"
    if [[ "${GH_STUB_FAIL_FIRST:-}" == "1" && "${n}" == "1" ]]; then
      printf 'transient failure\n' >&2
      exit 1
    fi
    prev=""
    for a in "$@"; do
      if [[ "${prev}" == "--input" ]]; then cp "${a}" "${GH_STUB_CAPTURE}"; fi
      prev="${a}"
    done
    printf '{}\n'
    ;;
  *"/reviews"*)
    printf '[]\n'
    ;;
  *) printf '%s\t%s\tfalse\topen\t%s\t%s\n' "${GH_STUB_HEAD}" "${GH_STUB_BASE}" "${GH_STUB_BASEREF:-main}" "${GH_STUB_DEFAULT:-main}" ;;
esac
STUB
chmod +x "${kdir}/bin/gh"
printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,5 @@\n+x\n' > "${kdir}/tmp/muse.diff"
printf '[{"filename":"a.ts"}]' > "${kdir}/tmp/muse-files.json"
printf '%s' '{"verdict":"leak AIza0123456789 (see inline)AbCdEfGhIjKlMnOpQrStUvWx end","findings":[{"path":"a.ts","line":1,"severity":"low","title":"t","body":"b"}],"next_steps":[]}' > "${kdir}/tmp/review.json"
rm -f "${kdir}/count" "${kdir}/posted" "${kdir}/capture.json"
GH_STUB_COUNT="${kdir}/count" GH_STUB_POSTED="${kdir}/posted" GH_STUB_CAPTURE="${kdir}/capture.json" GH_STUB_HEAD="${rsha}" GH_STUB_BASE="${rbsha}" GH_STUB_FAIL_FIRST="1" GH_STUB_LANDED="" \
PATH="${kdir}/bin:${PATH}" \
GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" \
HEAD_SHA="${rsha}" BASE_SHA="${rbsha}" HEAD_SHA_EVENT="${rsha}" BASE_SHA_EVENT="${rbsha}" \
MUSE_OUTCOME="success" DIFF_FAILED="false" DIFF_OUTCOME="success" \
REVIEW_FILE="${kdir}/tmp/review.json" RUN_URL="https://example.invalid/run" \
RUNNER_TEMP="${kdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" \
  bash "${post_script}" >/dev/null 2>&1
case "$(jq -r '.body // ""' "${kdir}/capture.json" 2>/dev/null)" in *"AIza0123456789AbCdEfGhIjKlMnOpQrStUvWx"*) got_k="joined";; *) got_k="split";; esac
assert_eq "post-retry-pointer-not-joined" "split" "${got_k}"
case "$(jq -r '.body // ""' "${kdir}/capture.json" 2>/dev/null)" in *"(details in the inline findings below)"*) got_k="yes";; *) got_k="no";; esac
assert_eq "post-retry-pointer-separator-kept" "yes" "${got_k}"
rm -rf "${kdir}"

# --- guard.sh live base-ref revalidation (script level) ---
# Same-SHA retarget to a custom branch changes no SHA/draft/state; the
# live base ref must still be the default branch or the run is stale.
udir="$(mktemp -d)"
mkdir -p "${udir}/bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${GH_STUB_TSV}"\n' > "${udir}/bin/gh"
chmod +x "${udir}/bin/gh"
uhead="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ubase="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
guard_script="${SCRIPT_DIR}/guard.sh"
: > "${udir}/out.txt"
urow="$(printf '%s\t%s\tfalse\topen\tmain\tmain' "${uhead}" "${ubase}")"
GH_STUB_TSV="${urow}" PATH="${udir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA="${uhead}" BASE_SHA="${ubase}" GITHUB_OUTPUT="${udir}/out.txt" bash "${guard_script}" >/dev/null 2>&1
assert_eq "guard-default-base-fresh" "fresh=true" "$(cat "${udir}/out.txt")"
: > "${udir}/out.txt"
urow="$(printf '%s\t%s\tfalse\topen\tcustom-base\tmain' "${uhead}" "${ubase}")"
GH_STUB_TSV="${urow}" PATH="${udir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA="${uhead}" BASE_SHA="${ubase}" GITHUB_OUTPUT="${udir}/out.txt" bash "${guard_script}" >/dev/null 2>&1
assert_eq "guard-retargeted-base-stale" "fresh=false" "$(cat "${udir}/out.txt")"
rm -rf "${udir}"

# --- collect.sh private-fetch Basic auth header (script level) ---
# Git Smart HTTP takes the token as a Basic password (x-access-token),
# not REST-style Bearer; stub git logs argv, fails the anonymous fetch,
# and lets the retry succeed so its header can be inspected.
adir="$(mktemp -d)"
mkdir -p "${adir}/tmp" "${adir}/bin"
cat > "${adir}/bin/git" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GIT_STUB_LOG}"
n=0
if [[ -f "${GIT_STUB_COUNT}" ]]; then n="$(cat "${GIT_STUB_COUNT}")"; fi
n=$((n + 1))
printf '%s' "${n}" > "${GIT_STUB_COUNT}"
case " $* " in
  *" fetch "*)
    if [[ "${n}" == "1" ]]; then exit 1; fi
    exit 0
    ;;
  *" merge-base "*) exit 1 ;;
  *) exit 0 ;;
esac
STUB
cat > "${adir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *"/files"*) printf '[]\n' ;;
  *"/pulls/"*) cat "${GH_STUB_PR_JSON}" ;;
  *) printf '{}\n' ;;
esac
STUB
chmod +x "${adir}/bin/git" "${adir}/bin/gh"
ahead="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
abase="ffffffffffffffffffffffffffffffffffffffff"
python3 -c "
import json
print(json.dumps({'head': {'sha': '${ahead}', 'ref': 'feat'}, 'base': {'ref': 'main', 'sha': '${abase}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" > "${adir}/pr.json"
: > "${adir}/tmp/out.txt"
collect_script="${SCRIPT_DIR}/collect.sh"
GIT_STUB_LOG="${adir}/git.log" GIT_STUB_COUNT="${adir}/git.count" GH_STUB_PR_JSON="${adir}/pr.json" PATH="${adir}/bin:${PATH}" GH_TOKEN="faketoken123" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${ahead}" GITHUB_OUTPUT="${adir}/tmp/out.txt" RUNNER_TEMP="${adir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}" >/dev/null 2>&1
want_b64="$(python3 -c "import base64; print(base64.b64encode(b'x-access-token:faketoken123').decode())")"
case "$(sed -n '2p' "${adir}/git.log" 2>/dev/null)" in *"Authorization: Basic ${want_b64}"*) got_a="basic";; *) got_a="wrong";; esac
assert_eq "collect-fetch-basic-auth" "basic" "${got_a}"
rm -rf "${adir}"

# --- collect.sh fallback inventory pinned to captured SHAs (script level) ---
# Stub git lets the base fetch succeed but merge-base fail, forcing the
# API fallback with base guidance available. Stub gh serves a DIFFERENT
# (live B) list on the PR-files endpoint and the pinned A list on
# compare/base...head: the inventory must come from the captured pair,
# the live endpoint must never be requested, and a 300-file compare
# response (the silent truncation cap) must fail closed.
fdir="$(mktemp -d)"
mkdir -p "${fdir}/tmp" "${fdir}/bin" "${fdir}/repo"
cat > "${fdir}/bin/git" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" merge-base "*) exit 1 ;;
  *) exit 0 ;;
esac
STUB
cat > "${fdir}/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_STUB_LOG}"
args=" $* "
case "${args}" in
  *"/compare/"*) cat "${GH_STUB_COMPARE_JSON}" ;;
  *"/files"*) printf '[{"filename":"live-b.ts","status":"modified","additions":9,"deletions":9}]\n' ;;
  *"/pulls/"*) cat "${GH_STUB_PR_JSON}" ;;
  *) printf '{}\n' ;;
esac
STUB
chmod +x "${fdir}/bin/git" "${fdir}/bin/gh"
git -C "${fdir}/repo" init -q 2>/dev/null
fhead="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fbase="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
python3 -c "
import json
print(json.dumps({'head': {'sha': '${fhead}', 'ref': 'feat'}, 'base': {'ref': 'main', 'sha': '${fbase}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" > "${fdir}/pr.json"
printf '%s' '{"files":[{"filename":"pinned-a.ts","status":"modified","additions":1,"deletions":1}]}' > "${fdir}/compare.json"
: > "${fdir}/tmp/out.txt"
: > "${fdir}/gh.log"
collect_script="${SCRIPT_DIR}/collect.sh"
(cd "${fdir}/repo" && GH_STUB_LOG="${fdir}/gh.log" GH_STUB_COMPARE_JSON="${fdir}/compare.json" GH_STUB_PR_JSON="${fdir}/pr.json" PATH="${fdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${fhead}" GITHUB_OUTPUT="${fdir}/tmp/out.txt" RUNNER_TEMP="${fdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
assert_eq "collect-pinned-files" "pinned-a.ts" "$(jq -r '.[].filename' "${fdir}/tmp/muse-files.json" 2>/dev/null)"
case "$(cat "${fdir}/gh.log" 2>/dev/null)" in *"compare/${fbase}...${fhead}"*) got_f="pinned-url";; *) got_f="live-url";; esac
assert_eq "collect-pinned-url" "pinned-url" "${got_f}"
case "$(cat "${fdir}/gh.log" 2>/dev/null)" in *"/files"*) got_f="live-hit";; *) got_f="no-live";; esac
assert_eq "collect-no-live-files-endpoint" "no-live" "${got_f}"
case "$(cat "${fdir}/tmp/muse-vars.env" 2>/dev/null)" in *"MUSE_FILES_FAILED=false"*) got_f="complete";; *) got_f="fallback";; esac
assert_eq "collect-pinned-complete" "complete" "${got_f}"
python3 -c "import json; print(json.dumps({'files': [{'filename': 'f%03d.ts' % i, 'status': 'modified', 'additions': 1, 'deletions': 0} for i in range(300)]}))" > "${fdir}/compare.json"
: > "${fdir}/tmp/out.txt"
(cd "${fdir}/repo" && GH_STUB_LOG="${fdir}/gh.log" GH_STUB_COMPARE_JSON="${fdir}/compare.json" GH_STUB_PR_JSON="${fdir}/pr.json" PATH="${fdir}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${fhead}" GITHUB_OUTPUT="${fdir}/tmp/out.txt" RUNNER_TEMP="${fdir}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
case "$(cat "${fdir}/tmp/muse-vars.env" 2>/dev/null)" in *"MUSE_FILES_FAILED=true"*) got_f="fallback";; *) got_f="complete";; esac
assert_eq "collect-compare-cap-fails-closed" "fallback" "${got_f}"
rm -rf "${fdir}"

# --- collect.sh non-UTF-8 changed path fails closed (script level) ---
# jq --arg would rewrite the raw bytes to U+FFFD and the inventory would
# name a path that does not exist; the run must fall back instead.
udir2="$(mktemp -d)"
mkdir -p "${udir2}/tmp" "${udir2}/bin" "${udir2}/repo"
cat > "${udir2}/bin/gh" <<'STUB'
#!/usr/bin/env bash
args=" $* "
case "${args}" in
  *"/pulls/"*) cat "${GH_STUB_PR_JSON}" ;;
  *) printf '{}\n' ;;
esac
STUB
chmod +x "${udir2}/bin/gh"
git -C "${udir2}/repo" init -q 2>/dev/null
printf 'base\n' > "${udir2}/repo/f.txt"
git -C "${udir2}/repo" add f.txt 2>/dev/null
git -C "${udir2}/repo" -c user.email=t@t -c user.name=t commit -qm base 2>/dev/null
ubase="$(git -C "${udir2}/repo" rev-parse HEAD 2>/dev/null)"
# Build the head commit by plumbing: macOS filesystems reject non-UTF-8
# names, but a tree entry can carry the raw bytes without a checkout.
uhead="$(python3 -c "
import subprocess
repo = b'${udir2}/repo'
blob = subprocess.check_output([b'git', b'-C', repo, b'hash-object', b'-w', b'--stdin'], input=b'x').strip()
bad = b'bad' + bytes([255]) + b'.ts'
subprocess.check_call([b'git', b'-C', repo, b'update-index', b'--add', b'--cacheinfo', b'100644,' + blob + b',' + bad])
tree = subprocess.check_output([b'git', b'-C', repo, b'write-tree']).strip()
head = subprocess.check_output([b'git', b'-C', repo, b'-c', b'user.email=t@t', b'-c', b'user.name=t', b'commit-tree', tree, b'-p', b'${ubase}', b'-m', b'head']).strip()
print(head.decode())
")"
git -C "${udir2}/repo" update-ref HEAD "${uhead}" 2>/dev/null
git -C "${udir2}/repo" remote add origin "file://${udir2}/repo" 2>/dev/null
python3 -c "
import json
print(json.dumps({'head': {'sha': '${uhead}', 'ref': 'feat'}, 'base': {'ref': 'main', 'sha': '${ubase}', 'repo': {'default_branch': 'main'}}, 'state': 'open', 'title': 't', 'body': ''}))
" > "${udir2}/pr.json"
: > "${udir2}/tmp/out.txt"
collect_script="${SCRIPT_DIR}/collect.sh"
(cd "${udir2}/repo" && GH_STUB_PR_JSON="${udir2}/pr.json" PATH="${udir2}/bin:${PATH}" GH_TOKEN="fake" GITHUB_REPOSITORY="t/t" PR_NUMBER="1" HEAD_SHA_EVENT="${uhead}" GITHUB_OUTPUT="${udir2}/tmp/out.txt" RUNNER_TEMP="${udir2}/tmp" SCRIPT_DIR="${SCRIPT_DIR}" bash "${collect_script}") >/dev/null 2>&1
case "$(cat "${udir2}/tmp/muse-vars.env" 2>/dev/null)" in *"MUSE_FILES_FAILED=true"*) got_u="fallback";; *) got_u="complete";; esac
assert_eq "collect-nonutf8-path-fails-closed" "fallback" "${got_u}"
rm -rf "${udir2}"

printf '\npass=%d fail=%d%s\n' "${pass}" "${fail}" "${fail_names:+  failed:${fail_names}}"
[[ "${fail}" == "0" ]]
