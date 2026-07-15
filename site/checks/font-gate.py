# Font gate — fvar axes + @font-face descriptor consistency + glyph coverage (Spec §4).
# Usage (from site/checks/): uvx --from "fonttools[woff]" python3 font-gate.py
# No server needed — reads HTML/CSS/woff2 straight from the repo working tree.
#
# Three invariants, frozen 2026-07-15 (M1 manual verification promoted to machine check;
# M2 final-review backlog "字體自動化 gate"; same-named sibling in konvolut-site checks/):
#
#  1. Fraunces faces keep the four axes exactly as shipped upstream — tag set AND
#     (min, default, max) triples. pyftsubset preserves fvar verbatim, so any drift here
#     means a re-subset changed the source file or dropped axes (M1 對帳 verified these
#     values against upstream once; the gate detects drift from that verified baseline).
#  2. Every @font-face descriptor matches its file: variable faces must declare exactly
#     the font's fvar wght range (a NARROWER descriptor silently clamps requests — this
#     repo's Familjen "400 600" vs file 400–700 bug rendered bold as semi-bold; a WIDER
#     one lies about coverage the same way). Static faces must declare a single weight
#     equal to OS/2 usWeightClass — Noto TC stays exact 400 on purpose so the browser
#     synthesizes 600/700 (M3 T5 adjudication, see the comment in css/site.css).
#  3. Glyph coverage: every rendered character (body text nodes + CSS content strings)
#     must exist in the cmap union of the faces that page is allowed to load. The EN page
#     deliberately excludes Noto TC from that union — a CJK char sneaking into it would
#     trigger a Noto download (breaking the EN webfont budget / external-requests
#     expectations) and must be flagged here, not shipped.
#     Limitation: static scan only — site.js-injected instrument labels (W/D/H readouts,
#     millimetre numerals) are ASCII in the Plex faces and aren't seen by this scan.

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent  # = site/

# 每頁可用的字面集合：EN 頁排除 Noto TC（zh 頁才載——見上方不變量 3）。
LATIN_FACES = {"fraunces-var.woff2", "fraunces-italic-var.woff2", "familjen.woff2",
               "plex-mono.woff2", "plex-mono-500.woff2"}
NOTO = {"noto-serif-tc-subset.woff2"}
PAGES = {
    "index.html": LATIN_FACES,
    "zh/index.html": LATIN_FACES | NOTO,
}
CSS_FILES = ["css/site.css", "css/tokens.css"]  # @font-face truth source + tokens

FRAUNCES_AXES = {  # tag: (min, default, max) — frozen baseline, both roman and italic
    "opsz": (9.0, 9.0, 144.0),
    "wght": (100.0, 900.0, 900.0),
    "SOFT": (0.0, 0.0, 100.0),
    "WONK": (0.0, 1.0, 1.0),
}

EXEMPT = {"­", "​", "‌", "‍", "﻿"}  # soft hyphen + zero-widths

# 設計裁決過的 EN 頁 CJK 例外——「中文」＝folio 語言切換器標籤（M3 T4·D5），
# 刻意走系統字 fallback、不載 Noto。除這兩字外，EN 頁出現任何 CJK 都是文案迴歸。
PAGE_EXEMPT = {"index.html": set("中文")}

failures = []


class PageScan(HTMLParser):
    """Collect rendered body text + inline <style> contents."""
    def __init__(self):
        super().__init__()
        self.text, self.css = [], []
        self._skip = 0          # inside <script>
        self._style = 0         # inside <style>
        self._body = False

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self._skip += 1
        elif tag == "style":
            self._style += 1
        elif tag == "body":
            self._body = True

    def handle_endtag(self, tag):
        if tag == "script":
            self._skip = max(0, self._skip - 1)
        elif tag == "style":
            self._style = max(0, self._style - 1)

    def handle_data(self, data):
        if self._style:
            self.css.append(data)
        elif self._body and not self._skip:
            self.text.append(data)


def strip_comments(css_text):
    # 註解裡的 "font-weight:…" / "content:…" 敘述會污染 regex 解析
    # （od Noto 註解的「<b> (550);」實際炸過一次）——進解析前一律剝掉。
    return re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)


def css_content_strings(css_text):
    return "".join(m.group(2) for m in
                   re.finditer(r"""content:\s*(['"])(.*?)\1""",
                               strip_comments(css_text), re.S))


def parse_font_faces(css_text):
    """[(family, src-basename, weight-descriptor-string)] out of hand-written CSS."""
    faces = []
    for block in re.findall(r"@font-face\s*{([^}]*)}", strip_comments(css_text), re.S):
        fam = re.search(r"""font-family:\s*['"]?([^'";]+)""", block)
        src = re.search(r"""url\(['"]?([^'")]+)""", block)
        wgt = re.search(r"font-weight:\s*([^;]+);", block)
        if fam and src:
            faces.append((fam.group(1).strip(), Path(src.group(1)).name,
                          wgt.group(1).strip() if wgt else "400"))
    return faces


# ---- 讀 CSS（外部檔＋各頁 inline）與各頁文字 ----------------------------------
shared_css = "".join((ROOT / c).read_text(encoding="utf-8") for c in CSS_FILES)
page_scans = {}
for page in PAGES:
    scan = PageScan()
    scan.feed((ROOT / page).read_text(encoding="utf-8"))
    page_scans[page] = scan

all_css = shared_css + "".join("".join(s.css) for s in page_scans.values())

# ---- 不變量 1+2：@font-face descriptor ↔ 字體檔 --------------------------------
seen = {}
for fam, fname, wdesc in parse_font_faces(all_css):
    key = (fname, wdesc)
    if key in seen:
        continue
    seen[key] = True
    fpath = ROOT / "fonts" / fname
    if not fpath.exists():
        failures.append(f"@font-face src 不存在: {fname}")
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

# ---- 不變量 3：glyph coverage ---------------------------------------------------
cmaps = {}
for fname in LATIN_FACES | NOTO:
    fpath = ROOT / "fonts" / fname
    if fpath.exists():
        cmaps[fname] = set(TTFont(fpath).getBestCmap().keys())

total_chars = 0
for page, allowed in PAGES.items():
    scan = page_scans[page]
    union = set().union(*(cmaps[f] for f in allowed if f in cmaps))
    text = "".join(scan.text) + css_content_strings(shared_css + "".join(scan.css))
    chars = {c for c in text if not c.isspace() and c not in EXEMPT
             and c not in PAGE_EXEMPT.get(page, ())}
    total_chars += len(chars)
    missing = sorted(c for c in chars if ord(c) not in union)
    if missing:
        failures.append(f"{page}: {len(missing)} 個字元不在該頁字面聯集 cmap："
                        + " ".join(f"{c}(U+{ord(c):04X})" for c in missing[:20])
                        + (" …" if len(missing) > 20 else ""))

if failures:
    print("FONT-GATE FAIL:", *failures, sep="\n  ")
    sys.exit(1)
print(f"FONT-GATE OK — {len(seen)} faces (descriptors match files, Fraunces axes frozen), "
      f"{len(PAGES)} pages scanned, {total_chars} unique glyph refs all covered")
