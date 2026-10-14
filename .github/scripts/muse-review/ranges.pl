# New-side diff ranges as JSON: [{"path","start","end"}].
#
# Usage: perl ranges.pl <unified-diff-file>
#
# Single-pass: C-escapes in +++ paths (octal, named, quote, backslash) are
# decoded and control chars JSON-escaped in one process, so there is no
# delimited handoff where a decoded tab/newline could corrupt record framing.
# Hunks for /dev/null (pure deletions) and zero-length new sides are skipped.
# The input may be byte-truncated for the prompt, so a hunk header's declared
# new-side length is an upper bound only: each range is clamped to the
# new-side lines actually present, and a hunk whose body is entirely cut
# validates nothing.
# Prints [] on any read failure; callers still validate with `jq empty`.
use strict;
use warnings;

my ($diff) = @ARGV;
my @out;
my $f;
my ($pf, $ps, $pl, $seen);

if (defined $diff and open(my $fh, '<', $diff)) {
  my $prev = "";
  my $in_hunk = 0;
  my $flush = sub {
    if (defined $pf and $pl > 0 and $seen > 0) {
      my $l = $pl < $seen ? $pl : $seen;
      my $e = $ps + $l - 1;
      (my $j = $pf) =~ s/\\/\\\\/g;
      $j =~ s/"/\\"/g;
      $j =~ s/([\x00-\x1f])/sprintf("\\u%04x", ord($1))/ge;
      push @out, "{\"path\":\"$j\",\"start\":$ps,\"end\":$e}";
    }
    ($pf, $ps, $pl, $seen) = (undef, 0, 0, 0);
  };
  while (my $line = <$fh>) {
    # Hunk state first: a removed "-- x" / added "++ y" content pair renders
    # as adjacent "--- x" / "+++ y" lines INSIDE the hunk, which the pair
    # check below would otherwise mistake for file headers and misattribute
    # every later hunk. Headers only occur outside hunks.
    if ($line =~ /^diff --git /) { $flush->(); $in_hunk = 0; }
    elsif ($line =~ /^@@ /) { $in_hunk = 1; }
    # A +++ line is a file header only right after a --- line and outside
    # a hunk: added file content (e.g. a line whose text is "++ b/x") can
    # otherwise forge a header and poison every range. The --- check comes
    # first so $1 still holds the +++ capture (each match resets captures).
    if (!$in_hunk and $prev =~ /^--- / and $line =~ /^\+\+\+ (.*)$/) {
      $f = $1;
      chomp $f;
      # Git appends a TAB after +++ paths containing spaces (also inside
      # quotes): strip it before unquoting or the path never matches.
      $f =~ s/\t$//;
      $f =~ s/^"(.*)"$/$1/;
      $f =~ s{^b/}{};
      $f =~ s/\\([0-7]{3}|[abtnfvr"\\])/length($1)==3?chr(oct($1)):($1 eq "a"?"\a":$1 eq "b"?"\b":$1 eq "t"?"\t":$1 eq "n"?"\n":$1 eq "v"?chr(11):$1 eq "f"?"\f":$1 eq "r"?"\r":$1)/ge;
    }
    if ($line =~ /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/) {
      $flush->();
      if (defined $f and $f ne "/dev/null") {
        $ps = $1;
        $pl = (defined $2 ? $2 : 1);
        $pf = $f;
        $seen = 0;
      }
    } elsif ($in_hunk and $line =~ /^[+ ]/) {
      $seen++;
    }
    $prev = $line;
  }
  $flush->();
  close $fh;
}
print "[" . join(",", @out) . "]";
