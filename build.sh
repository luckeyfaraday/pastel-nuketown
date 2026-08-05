#!/usr/bin/env bash
# Assemble the single-file entry from src/ parts + the two shared modules.
# House convention: an entry is exactly one <folder>/index.html.
set -euo pipefail
cd "$(dirname "$0")"

OUT=index.html
TMP=".build.tmp"
MODE="${1:-build}"

if [[ "$MODE" != "build" && "$MODE" != "--check" ]]; then
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 2
fi

trap 'rm -f "$TMP"' EXIT

{
  echo '<!doctype html>'
  echo '<html lang="en">'
  cat src/00-head.html
  echo '<body>'
  cat src/01-body.html

  # Three.js is third-party code running with this page's privileges, on a page
  # that keeps a thirty-day bearer token in localStorage. The scrubber in
  # src/00-head.html keeps a freshly issued token out of the address bar and out
  # of this script's reach on the way past, which is worth doing and is not the
  # whole job: a substituted CDN response could simply read the stored token on
  # the next load instead. The version is pinned, so pin the bytes as well and
  # a response that is not this file does not execute at all.
  #
  # jsDelivr and unpkg serve three@0.128.0 byte for byte identically, so one
  # digest covers the fallback too. `crossorigin` is not decoration: without it
  # the browser will not check the hash. Recompute both if the version moves —
  #   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
  # and store.test.js fails the build if either tag loses its integrity.
  THREE_SRI='sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu'
  echo "<script src=\"https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js\" integrity=\"$THREE_SRI\" crossorigin=\"anonymous\"></script>"
  echo '<script>'
  echo 'if (typeof THREE === "undefined") {'
  echo "  document.write(\"<scr\"+\"ipt src=\\\"https://unpkg.com/three@0.128.0/build/three.min.js\\\" integrity=\\\"$THREE_SRI\\\" crossorigin=\\\"anonymous\\\"></scr\"+\"ipt>\");"
  echo '}'
  echo '</script>'

  for f in mapspec.js bots.js net-protocol.js; do
    echo "<script>/* ===== $f ===== */"
    cat "$f"
    echo '</script>'
  done

  for f in src/10-core.js src/20-world.js src/30-physics.js src/40-weapons.js \
           src/50-actors.js src/60-fx.js src/70-game.js src/72-pickups.js src/75-network.js \
           src/78-touch.js src/80-ui.js src/82-store.js src/90-main.js; do
    echo "<script>/* ===== $f ===== */"
    cat "$f"
    echo '</script>'
  done

  echo '</body>'
  echo '</html>'
} > "$TMP"

if [[ "$MODE" == "--check" ]]; then
  if cmp -s "$TMP" "$OUT"; then
    printf '%s is current\n' "$OUT"
  else
    printf '%s is stale; run npm run build\n' "$OUT" >&2
    exit 1
  fi
else
  mv "$TMP" "$OUT"
  trap - EXIT
  printf 'built %s  (%s bytes)\n' "$OUT" "$(wc -c < "$OUT")"
fi
