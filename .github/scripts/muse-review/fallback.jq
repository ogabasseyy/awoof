[add // [] | .[] | select(.user.login == "github-actions[bot]"
  and ((.body | split("\n") | .[1] // "") == "<!-- muse-fallback:v1 -->")
  and ((.body | startswith($marker))
    or ((.submitted_at // "1970-01-01T00:00:00Z" | fromdateiso8601) > (now - 86400))))] | length
