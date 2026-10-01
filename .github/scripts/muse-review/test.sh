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
assert_eq "symlinks-targets" "$(printf 'leak.txt -> /etc\nsub/rel -> ../real.txt')" "${got}"
got="$(changed_symlinks "${symdir}/files.json" "${symdir}/ws" 1 2>/dev/null)"; got_rc=$?
assert_eq "symlinks-overcap-first" "leak.txt -> /etc" "${got}"
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
assert_eq "symlinks-flattens-newline" 'nl.txt -> a\nb' "${got}"
longt="$(python3 -c "print('t'*600)")"
ln -s "${longt}" "${symdir}/ws/long.txt"
printf '[{"filename":"long.txt"}]' > "${symdir}/longf.json"
got="$(changed_symlinks "${symdir}/longf.json" "${symdir}/ws" 50)"
assert_eq "symlinks-target-cap" "512" "$(printf '%s' "${got}" | wc -c | tr -d ' ')"
rm -rf "${symdir}"

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

# --- ranges.pl ---
diff_fix="$(mktemp)"
printf 'diff --git "a/foo\\tb.ts" "b/foo\\tb.ts"\n--- "a/foo\\tb.ts"\n+++ "b/foo\\tb.ts"\n@@ -1,3 +1,4 @@ ctx\n+x\n+++ b/forged.ts\n+y\ndiff --git a/p.ts b/p.ts\n--- a/p.ts\n+++ b/p.ts\n@@ -10 +12,2 @@\n+y\n+z\n--- b/victim.ts\n+++ b/other.ts\n@@ -20 +22,2 @@\n+q\n+r\ndiff --git a/d.ts b/d.ts\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/my file.ts b/my file.ts\n--- "a/my file.ts"\t\n+++ "b/my file.ts"\t\n@@ -2 +2 @@\n+z\n' > "${diff_fix}"
got="$(perl "${SCRIPT_DIR}/ranges.pl" "${diff_fix}")"
assert_eq "ranges-json" '[{"path":"foo\u0009b.ts","start":1,"end":4},{"path":"p.ts","start":12,"end":13},{"path":"p.ts","start":22,"end":23},{"path":"my file.ts","start":2,"end":2}]' "${got}"
if printf '%s' "${got}" | jq empty 2>/dev/null; then got_jq="yes"; else got_jq="no"; fi
assert_eq "ranges-valid-json" "yes" "${got_jq}"
assert_eq "ranges-missing-file" "[]" "$(perl "${SCRIPT_DIR}/ranges.pl" "/nonexistent-muse-test-$$")"
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
got="$(jq --slurpfile ranges "${ranges_fix}" --slurpfile files "${files_fix}" -f "${SCRIPT_DIR}/validate.jq" "${find_fix}" | jq -c '{v:[.valid[].title],s:[.summary_only[]|{t:.title,o:(.orphaned//false)}]}')"
assert_eq "validate-split" '{"v":["T1"],"s":[{"t":"T3","o":false},{"t":"T2","o":false},{"t":"T5","o":true},{"t":"T4","o":true}]}' "${got}"
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

# --- schema.json ---
if jq -e '.type == "object" and .additionalProperties == false and (.required | length) == 3' "${SCRIPT_DIR}/schema.json" >/dev/null 2>&1; then got_schema="yes"; else got_schema="no"; fi
assert_eq "schema-shape" "yes" "${got_schema}"

# --- paginated PR-files inventory merge (collect.sh) ---
# gh --paginate emits one JSON document per page; only array pages merge,
# so a mid-stream error object can never masquerade as a file list.
pages_fix="$(mktemp)"
printf '[{"filename":"a.ts"}]\n[{"filename":"b.ts"}]\n{"message":"API error"}\n' > "${pages_fix}"
got="$(jq -s '[.[] | select(type == "array")] | add // []' "${pages_fix}")"
assert_eq "pages-merge" '[{"filename":"a.ts"},{"filename":"b.ts"}]' "$(printf '%s' "${got}" | jq -c '.')"
printf '{"message":"only errors"}\n' > "${pages_fix}"
got="$(jq -s '[.[] | select(type == "array")] | add // []' "${pages_fix}")"
assert_eq "pages-all-error" '[]' "$(printf '%s' "${got}" | jq -c '.')"
rm -f "${pages_fix}"

printf '\npass=%d fail=%d%s\n' "${pass}" "${fail}" "${fail_names:+  failed:${fail_names}}"
[[ "${fail}" == "0" ]]
