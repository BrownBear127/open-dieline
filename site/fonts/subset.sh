#!/bin/bash
# Latin subset for dieline.konvolut.art. Keep variable axes (no instancing).
set -e
SRC=/tmp/fonts-src; OUT="$(dirname "$0")"
UNI="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2022,U+00D7,U+2715,U+2192,U+00B7,U+2039,U+203A,U+00BA,U+00B0"
common=(--flavor=woff2 --layout-features='*' --unicodes="$UNI")
uvx --from fonttools pyftsubset "$SRC/Fraunces[SOFT,WONK,opsz,wght].ttf"        "${common[@]}" --output-file="$OUT/fraunces-var.woff2"
uvx --from fonttools pyftsubset "$SRC/Fraunces-Italic[SOFT,WONK,opsz,wght].ttf" "${common[@]}" --output-file="$OUT/fraunces-italic-var.woff2"
uvx --from fonttools pyftsubset "$SRC/FamiljenGrotesk[wght].ttf"                "${common[@]}" --output-file="$OUT/familjen.woff2"
uvx --from fonttools pyftsubset "$SRC/IBMPlexMono-Regular.ttf"                  "${common[@]}" --output-file="$OUT/plex-mono.woff2"
uvx --from fonttools pyftsubset "$SRC/IBMPlexMono-Medium.ttf"                   "${common[@]}" --output-file="$OUT/plex-mono-500.woff2"

# ── Noto Serif TC subset for /zh/ (M3 Task 3) ──
# Source: https://github.com/google/fonts/raw/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf
# (16.8MB variable TTF, wght axis only — same URL used by the konvolut-site /zh/ subset).
# Char set = every unique non-space char in site/zh/index.html's rendered text (tags/scripts/
# styles stripped, HTML entities unescaped) = 248 chars (Latin + digits + punctuation + Hanzi,
# same full-set convention as the konvolut-site subset — Latin glyphs are needed because the
# body font stack lists Noto Serif TC before Fraunces, so any un-tagged Latin/digit/punctuation
# character inside zh body copy is drawn from this subset first).
#   python3 -c "... strip tags, html.unescape, sorted(set(non-space chars)) ..." > /tmp/zh-chars.txt
uvx --from fonttools pyftsubset /tmp/NotoSerifTC.ttf \
  --text-file=/tmp/zh-chars.txt --flavor=woff2 --layout-features='*' \
  --output-file="$OUT/noto-serif-tc-subset.woff2"
# Result: 126,180 bytes (123KB) — fvar wght axis retained (no static instancing needed, far
# under the 700KB/page budget). Glyph spot-check (10 chars incl. 攤/摺/鉛/毫): all present via
# fontTools cmap lookup.
