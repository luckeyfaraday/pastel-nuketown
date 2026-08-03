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

  echo '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>'
  echo '<script>'
  echo 'if (typeof THREE === "undefined") {'
  echo '  document.write("<scr"+"ipt src=\"https://unpkg.com/three@0.128.0/build/three.min.js\"></scr"+"ipt>");'
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
