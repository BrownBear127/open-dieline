#!/usr/bin/env bash
# checks/fonts/measure-subsets.sh — A8 可行性實測（Spec §6.3/I9）：對 charset.json 聯集
# 產各 face woff2、輸出 bytes 表。僅量測用；正式 vendor 在 T9（預算裁決後）。
set -euo pipefail
cd "$(dirname "$0")/../.."

# ① 重新收集三源聯集 charset（跟 checks/gates/charset.mjs 同步，寫 checks/fonts/charset.json）
node -e "import('./checks/gates/charset.mjs').then(m => m.run({ root: process.cwd() }))"

WORK=/tmp/p2-font-measure
mkdir -p "$WORK"

# ② latin/cjk 字元集各寫成暫存檔用 --text-file=（避開 shell escaping：latin 集含 <>[]()
#    等 shell 特殊字元、cjk 集數百字元不適合塞進單一 shell 參數）
python3 -c "
import json
d = json.load(open('checks/fonts/charset.json'))
open('$WORK/latin-chars.txt', 'w').write(d['latin'])
open('$WORK/cjk-chars.txt', 'w').write(d['cjk'])
print('latin', len(d['latin']), 'cjk', len(d['cjk']))
"

SRC=/tmp/fonts-src
cd "$WORK"

# ③ Latin faces：同 site/fonts/subset.sh 慣例（--flavor=woff2 --layout-features='*' 保留變軸
#    不 instancing；uvx --from fonttools，無 [woff] extra——逐字沿用該檔已驗證可行的呼叫）。
#    差異僅在字元來源：subset.sh 用固定 --unicodes 範圍，這裡換成本次聯集 --text-file。
common=(--flavor=woff2 --layout-features='*' --text-file="$WORK/latin-chars.txt")
uvx --from fonttools pyftsubset "$SRC/Fraunces[SOFT,WONK,opsz,wght].ttf"        "${common[@]}" --output-file="$WORK/fraunces-var.woff2"
uvx --from fonttools pyftsubset "$SRC/Fraunces-Italic[SOFT,WONK,opsz,wght].ttf" "${common[@]}" --output-file="$WORK/fraunces-italic-var.woff2"
uvx --from fonttools pyftsubset "$SRC/FamiljenGrotesk[wght].ttf"                "${common[@]}" --output-file="$WORK/familjen.woff2"
uvx --from fonttools pyftsubset "$SRC/IBMPlexMono-Regular.ttf"                  "${common[@]}" --output-file="$WORK/plex-mono.woff2"
uvx --from fonttools pyftsubset "$SRC/IBMPlexMono-Medium.ttf"                   "${common[@]}" --output-file="$WORK/plex-mono-500.woff2"

# ④ Noto Serif TC：同 subset.sh 正式流程（T5 起）——先 varLib.instancer 靜態化 wght=400
#    （zh 頁 mobile Lighthouse 教訓：variable 檔比 static 400 多背 79,780B，見 subset.sh 註解）
#    再 pyftsubset 對本次聯集 cjk 字元。
uvx --from fonttools fonttools varLib.instancer --static -o "$WORK/od-static400.ttf" \
  /tmp/NotoSerifTC.ttf "wght=400"
uvx --from fonttools pyftsubset "$WORK/od-static400.ttf" \
  --text-file="$WORK/cjk-chars.txt" --flavor=woff2 \
  --output-file="$WORK/noto-serif-tc-subset.woff2"

echo "--- per-face bytes ---"
ls -la "$WORK"/*.woff2 | awk '{s+=$5; print $5, $9} END {print "TOTAL", s}'
