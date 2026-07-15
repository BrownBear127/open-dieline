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
#
# 2026-07-15 執行紀錄（T5·取代上一版單一 variable 檔）：mobile Lighthouse LCP 在
# noto-serif-tc-subset.woff2（126,180B·200-900 variable）時卡 91 分（<95 門檻，zh 頁比 EN
# 多背這顆字型的全部重量——EN 也要 fraunces-italic 給 h1 的「Dieline」斜體，兩頁字型基線
# 其實一樣重，zh 純粹多一顆）。改法同 konvolut-site 的 T5 解法：
#   uvx --from fonttools fonttools varLib.instancer --static -o /tmp/od-static400.ttf \
#     /tmp/NotoSerifTC.ttf "wght=400"
#   uvx --from fonttools pyftsubset /tmp/od-static400.ttf \
#     --text-file=/tmp/zh-chars.txt --flavor=woff2 \
#     --output-file=noto-serif-tc-subset.woff2
# （靜態單一 400 字重、不加 `--layout-features='*'`）。產出 46,400B（比原本 126,180B 輕
# 79,780B）；cmap 對當時 250 char 集 0 missing（3 個符號 ⟨⟩✕ 兩版都沒有，靠 fallback 字體，
# 非本次引入的缺口）。css/site.css 的 @font-face `font-weight` 從騙人的寬範圍 `200 900`
# 改誠實宣告單一值 `400`，讓瀏覽器預設 `font-synthesis: weight` 對頁面唯一用到的 550 字重
# `<b>` 套 faux-bold（實測 `getComputedStyle` 確認唯一載入的 face 是 400、頁面截圖比對無
# 視覺回歸）。
#
# mobile LH：91→93（未達 95）。**否證紀錄**（三個都試過、量測結果一致=無效，不要重複嘗試）：
#   1. 把 site.css 內嵌進 zh/index.html（同 ks T5 解法）——render-blocking-insight 估計省
#      450ms，但實測 LCP 完全沒變（3151ms 前後一致）。結論：這頁的 LCP 瓶頸從一開始就是
#      Noto TC 字型本身的載入時間，不是 CSS render-blocking；估計值假設「沒有其他瓶頸」，
#      這裡不成立。
#   2. 把 noto preload 提到最前面（在 fraunces 兩顆之前）——零效果，Lantern 模擬不受
#      preload 順序影響。
#   3. 把 noto-serif-tc-subset.woff2 轉 base64 內嵌進 zh/index.html 自己的 `<style>`（省掉
#      一個獨立連線）——零效果：base64 膨脹（46KB→62KB 文字）抵銷了少一個請求的省下量，
#      淨變化在量測雜訊內。
# 診斷實驗（暫時把 zh 頁整個字體堆疊改成不含 Noto TC，完全零字型請求）證實 Noto TC 本身
# 就是唯一瓶頸：LCP 從 3151ms 降到 2851ms（=EN 頁基線），分數 92→95。但已經是靜態單一
# 400 字重、字元集掃到底——再往下沒有安全的裁減空間（Fraunces 共用兩頁、且
# `font-variant-numeric: tabular-nums`〔instrument 面板數字〕真的吃 GSUB 的 tnum
# 特性，動 Fraunces 的 layout-features 有真實回歸風險，故未嘗試）。**93 分是本地驗收
# harness（python http.server·無 HTTP/1.1 keep-alive）下已知、有文件記錄的殘餘落差**，
# 詳見 開發紀錄 concerns 段。
