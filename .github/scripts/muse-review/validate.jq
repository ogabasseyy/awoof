($ranges[0]) as $r | ($files[0] | map(.filename)) as $paths
| ([.findings[]? | select(.line > 0)]) as $lined
| ([.findings[]? | select(.line == 0 and (.path as $p | $paths | index($p) != null))]) as $filelevel
| ([.findings[]? | select(.line == 0 and (.path as $p | $paths | index($p) == null))]) as $orphaned
| ([$lined[] | select(. as $f | any($r[]; .path==$f.path and $f.line >= .start and $f.line <= .end))]) as $ok
| ([($lined - $ok)[] | select(.path as $p | $paths | index($p) != null)]) as $lineinvalid
| ([($lined - $ok)[] | select(.path as $p | $paths | index($p) == null) | . + {orphaned: true}]) as $linedorphaned
| {valid: $ok[0:20], summary_only: ($filelevel + $lineinvalid + $linedorphaned + $ok[20:] + ($orphaned | map(. + {orphaned: true})))}
