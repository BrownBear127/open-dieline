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
