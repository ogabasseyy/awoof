($ranges[0]) as $r | ($files[0] | map(.filename)) as $paths
| ([.findings[]? | select(.line > 0)]) as $lined
| ([.findings[]? | select(.line == 0 and (.path as $p | $paths | index($p) != null))]) as $filelevel
| ([.findings[]? | select(.line == 0 and (.path as $p | $paths | index($p) == null))]) as $orphaned
| ([$lined[] | select(. as $f | any($r[]; .path==$f.path and $f.line >= .start and $f.line <= .end))]) as $ok
| {valid: $ok[0:20], summary_only: ($filelevel + (($lined - $ok) | map(. + {orphaned: true})) + $ok[20:] + ($orphaned | map(. + {orphaned: true})))}
