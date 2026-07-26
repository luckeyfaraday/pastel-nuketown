#!/usr/bin/env bash
# Assemble the single-file entry from src/ parts + the two shared modules.
# House convention: an entry is exactly one <folder>/index.html.
set -euo pipefail
cd "$(dirname "$0")"

OUT=index.html
TMP=".build.tmp"

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

  for f in mapspec.js bots.js; do
    echo "<script>/* ===== $f ===== */"
    cat "$f"
    echo '</script>'
  done

  for f in src/10-core.js src/20-world.js src/30-physics.js src/40-weapons.js \
           src/50-actors.js src/60-fx.js src/70-game.js src/80-ui.js src/90-main.js; do
    echo "<script>/* ===== $f ===== */"
    cat "$f"
    echo '</script>'
  done

  echo '</body>'
  echo '</html>'
} > "$TMP"

mv "$TMP" "$OUT"
printf 'built %s  (%s bytes)\n' "$OUT" "$(wc -c < "$OUT")"
