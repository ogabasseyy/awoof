[add // [] | .[] | select(.user.login == "github-actions[bot]"
  and (.body | startswith($marker))
  and ((.body | split("\n") | .[1] // "") != "<!-- muse-fallback:v1 -->"))] | length
