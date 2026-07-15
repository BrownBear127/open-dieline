# Font gate — fvar axes + @font-face manifest/descriptor consistency + glyph coverage (Spec §4).
# Usage (from repo root): uvx --from "fonttools[woff]" python3 checks/font-gate.py
# No server needed — reads CSS/woff2/charset.json straight from the repo working tree.
#
# Ported from site/checks/font-gate.py (2026-07-16, Task 9). Three surgical changes from the
# site version, per T9 brief:
#   ① REQUIRED_FACES — this repo's six faces (src/styles/vocab.css manifest, T9 Step 2).
#   ② CSS source — src/styles/vocab.css + src/styles/tokens.css (this repo has no per-page
#      HTML/css/site.css split; vocab.css is the single frozen @font-face manifest).
#   ③ Glyph-coverage "declared literal" source — checks/fonts/charset.json (T8's
#      checks/gates/charset.mjs collector output: zh/en BoxModule literals ∪ runtime
#      charset ∪ CSS content strings), not an HTML/body-text scan. This repo is a React SPA
#      (index.html is a bare `<div id="root">` shell — no static rendered text to scan), so
#      the site version's HTMLParser page-scan mechanism doesn't apply and is dropped here;
#      charset.json's `latin` bucket is checked against the Familjen/Plex/Fraunces cmap
#      union, `cjk` (now including ①②③ — 2026-07-16 charset.mjs regex fix, Enclosed
#      Alphanumerics U+2460-24FF moved from latin to cjk bucket after T8 found the six latin
#      faces have no glyph for them) against Noto Serif TC's cmap.
#
# Invariants (frozen 2026-07-15 in the site version; carried over):
#  1. Manifest: the CSS this repo ships (vocab.css + tokens.css) must declare EXACTLY the
#     REQUIRED_FACES set — family, file, weight descriptor AND font-style, no missing, no
#     extra. (Site-version bug this guards against: a page that FORGOT an @font-face —
#     the M3 T3 bug — silently rendered in system fonts; caught back then only by a
#     document.fonts probe.)
#  2. Descriptor ↔ file: variable faces must declare exactly the font's fvar wght range
#     (NARROWER silently clamps; WIDER lies about coverage). Static faces declare a single
#     weight equal to OS/2 usWeightClass — Noto TC stays exact 400 on purpose so the browser
#     synthesizes 600/700 (same T5 adjudication as the site version). Fraunces keeps the
#     four axes exactly as shipped upstream (frozen baseline).
#  3. Glyph coverage: every character in charset.json's latin/cjk union must exist in the
#     cmap of the faces allowed to cover it (latin → Familjen/Plex/Fraunces union; cjk →
#     Noto). Documented exception: ▾ (U+25BE, vocab.css `.boxsel::after`) — six-face scan
#     (T8) found no upstream face has this glyph; 2026-07-16 法蘭裁決 = accept system-font
#     fallback (decorative-only, not text content). Skipped from the failure set but
#     printed, not silently dropped (same lesson as the site version's ✕ precedent).

import json
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent  # = repo root
FONT_DIR = ROOT / "public" / "fonts"
CHARSET_JSON = ROOT / "checks" / "fonts" / "charset.json"

# ── 必要字面 manifest（family, 檔名, font-weight descriptor, font-style）──
# 必須精確等於 src/styles/vocab.css 檔尾的 @font-face 區塊（缺一=頁面掉字面·多一=未審字面）。
REQUIRED_FACES = {
    ("Fraunces", "fraunces-var.woff2", "100 900", "normal"),
    ("Fraunces", "fraunces-italic-var.woff2", "100 900", "italic"),
    ("Familjen Grotesk", "familjen.woff2", "400 700", "normal"),
    ("IBM Plex Mono", "plex-mono.woff2", "400", "normal"),
    ("IBM Plex Mono", "plex-mono-500.woff2", "500", "normal"),
    ("Noto Serif TC", "noto-serif-tc-subset.woff2", "400", "normal"),
}

# charset.json 的 latin 桶用這五顆 face cmap 聯集驗，cjk 桶（含①②③）用 Noto 驗。
LATIN_FACE_FILES = {"fraunces-var.woff2", "fraunces-italic-var.woff2", "familjen.woff2",
                     "plex-mono.woff2", "plex-mono-500.woff2"}
NOTO_FACE_FILE = "noto-serif-tc-subset.woff2"

CSS_SOURCES = ["src/styles/vocab.css", "src/styles/tokens.css"]

FRAUNCES_AXES = {  # tag: (min, default, max) — frozen baseline, both roman and italic
    "opsz": (9.0, 9.0, 144.0),
    "wght": (100.0, 900.0, 900.0),
    "SOFT": (0.0, 0.0, 100.0),
    "WONK": (0.0, 1.0, 1.0),
}

EXEMPT = {"­", "​", "‌", "‍", "﻿"}  # soft hyphen + zero-widths

# 法蘭裁決（2026-07-16）：▾（U+25BE·vocab.css .boxsel::after 下拉箭頭）六 face 全無 glyph
# （T8 全量掃描實測），核可走系統字體 fallback（純裝飾用途、非文字內容）。coverage 檢查
# 跳過這個集合的成員，但顯性印出一行，不讓它靜默漏過（同站群 ✕ 教訓）。
DECORATIVE_FALLBACK_OK = {"▾"}

failures = []


def strip_comments(css_text):
    # 註解裡的 "font-weight:…" / "content:…" 敘述會污染 regex 解析——進解析前一律剝掉。
    return re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)


def parse_font_faces(css_text):
    """{(family, src-basename, weight-descriptor, style)} out of hand-written CSS."""
    faces = set()
    for block in re.findall(r"@font-face\s*{([^}]*)}", strip_comments(css_text), re.S):
        fam = re.search(r"""font-family:\s*['"]?([^'";]+)""", block)
        src = re.search(r"""url\(['"]?([^'")]+)""", block)
        wgt = re.search(r"font-weight:\s*([^;]+);", block)
        sty = re.search(r"font-style:\s*([^;]+);", block)
        if fam and src:
            faces.add((fam.group(1).strip(), Path(src.group(1)).name,
                       wgt.group(1).strip() if wgt else "400",
                       sty.group(1).strip() if sty else "normal"))
    return faces


def check_manifest(source_name, css_text):
    declared = parse_font_faces(css_text)
    for miss in sorted(REQUIRED_FACES - declared):
        failures.append(f"{source_name}: @font-face 缺 manifest 項 {miss}"
                        "（缺=此字面根本不會載入·T3 bug 家族）")
    for extra in sorted(declared - REQUIRED_FACES):
        failures.append(f"{source_name}: @font-face 有 manifest 外項 {extra}"
                        "（未審字面或 family/weight/style 寫錯）")


# ---- 讀 CSS 來源（vocab.css + tokens.css）---------------------------------------
css_text = "".join((ROOT / c).read_text(encoding="utf-8") for c in CSS_SOURCES)

# ---- 不變量 1：CSS 宣告的 @font-face 精確等於 manifest ---------------------------
check_manifest("+".join(CSS_SOURCES), css_text)

# ---- 不變量 2：manifest ↔ 字體檔 -------------------------------------------------
for fam, fname, wdesc, _sty in sorted(REQUIRED_FACES):
    fpath = FONT_DIR / fname
    if not fpath.exists():
        failures.append(f"manifest 字體檔不存在: {fname}")
        continue
    font = TTFont(fpath)
    parts = wdesc.split()
    lo, hi = (float(parts[0]), float(parts[-1]))
    if "fvar" in font:
        axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue)
                for a in font["fvar"].axes}
        wmin, _, wmax = axes.get("wght", (None, None, None))
        if (lo, hi) != (wmin, wmax):
            failures.append(f"{fname}: descriptor 'font-weight: {wdesc}' ≠ fvar wght "
                            f"[{wmin:g},{wmax:g}]（窄=clamp 半粗冒充、寬=謊報覆蓋）")
        if fam == "Fraunces" and axes != FRAUNCES_AXES:
            failures.append(f"{fname}: Fraunces 軸漂移 {axes} ≠ 凍結基線 {FRAUNCES_AXES}")
    else:
        uwc = font["OS/2"].usWeightClass
        if len(parts) != 1 or lo != uwc:
            failures.append(f"{fname}: static 檔 descriptor 'font-weight: {wdesc}' "
                            f"應為單值 {uwc}（合成粗體靠 exact 宣告觸發）")

# ---- 不變量 3：glyph coverage（宣告字面來源＝charset.json，非 HTML 掃描）----------
cmaps = {}
for fname in {f[1] for f in REQUIRED_FACES}:
    fpath = FONT_DIR / fname
    if fpath.exists():
        cmaps[fname] = set(TTFont(fpath).getBestCmap().keys())

latin_union = set().union(*(cmaps[f] for f in LATIN_FACE_FILES if f in cmaps))
noto_union = cmaps.get(NOTO_FACE_FILE, set())

charset = json.loads(CHARSET_JSON.read_text(encoding="utf-8"))

total_chars = 0
for label, text, union in (("latin", charset["latin"], latin_union),
                            ("cjk", charset["cjk"], noto_union)):
    chars = {c for c in text if not c.isspace() and c not in EXEMPT}
    fallback = chars & DECORATIVE_FALLBACK_OK
    for c in sorted(fallback):
        print(f"[font-gate] decorative fallback: {c} (documented exception)")
    chars -= DECORATIVE_FALLBACK_OK
    total_chars += len(chars)
    missing = sorted(c for c in chars if ord(c) not in union)
    if missing:
        failures.append(f"charset.json[{label}]: {len(missing)} 個字元不在 {label} face cmap 聯集："
                        + " ".join(f"{c}(U+{ord(c):04X})" for c in missing[:20])
                        + (" …" if len(missing) > 20 else ""))

if failures:
    print("FONT-GATE FAIL:", *failures, sep="\n  ")
    sys.exit(1)
print(f"FONT-GATE OK — manifest {len(REQUIRED_FACES)} faces, "
      f"descriptors/axes match files, "
      f"{total_chars} unique glyph refs covered (charset.json latin+cjk)")
