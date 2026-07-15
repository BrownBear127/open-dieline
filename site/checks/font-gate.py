# Font gate — fvar axes + @font-face manifest/descriptor consistency + glyph coverage (Spec §4).
# Usage (from site/checks/): uvx --from "fonttools[woff]" python3 font-gate.py
# No server needed — reads HTML/CSS/woff2 straight from the repo working tree.
#
# Invariants, frozen 2026-07-15 (M1 manual verification promoted to machine check; M2
# final-review backlog "字體自動化 gate"; sibling copy in konvolut-site checks/; hardened
# same day after M3 final review refuted v1 by mutation probe — v1 only checked faces
# the regex happened to find, so a page that FORGOT an @font-face (the exact M3 T3 bug:
# @font-face missing → zh page silently rendered in system fonts, caught back then only by
# a document.fonts probe) still passed, and font-style was never verified):
#
#  1. Face manifest: the CSS this site's pages consume (css/site.css + css/tokens.css +
#     any inline <style>) must declare EXACTLY the REQUIRED_FACES set — family, file,
#     weight descriptor AND font-style, no missing, no extra. Checked per page.
#  2. Descriptor ↔ file: variable faces must declare exactly the font's fvar wght range
#     (NARROWER silently clamps — this repo's Familjen "400 600" vs 400–700 file rendered
#     bold as semi-bold; WIDER lies about coverage). Static faces declare a single weight
#     equal to OS/2 usWeightClass — Noto TC stays exact 400 on purpose so the browser
#     synthesizes 600/700 (M3 T5 adjudication, see the comment in css/site.css). Fraunces
#     keeps the four axes exactly as shipped upstream (M1-verified baseline).
#  3. Glyph coverage: every rendered character (body text nodes + CSS content strings)
#     must exist in the cmap union of the faces the page BOTH declares and is allowed to
#     load. The EN page deliberately excludes Noto TC — stray CJK there would trigger a
#     Noto download (breaking the EN webfont budget / external-requests expectations).
#     Limitation: static scan only — site.js-injected instrument labels (W/D/H readouts,
#     millimetre numerals) are ASCII in the Plex faces and aren't seen by this scan.

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent  # = site/
FONT_DIR = ROOT / "fonts"

# ── 必要字面 manifest（family, 檔名, font-weight descriptor, font-style）──
# 每頁消費的 CSS 必須精確等於這組（缺一=頁面掉字面·多一=未審字面）。
REQUIRED_FACES = {
    ("Fraunces", "fraunces-var.woff2", "100 900", "normal"),
    ("Fraunces", "fraunces-italic-var.woff2", "100 900", "italic"),
    ("Familjen Grotesk", "familjen.woff2", "400 700", "normal"),
    ("IBM Plex Mono", "plex-mono.woff2", "400", "normal"),
    ("IBM Plex Mono", "plex-mono-500.woff2", "500", "normal"),
    ("Noto Serif TC", "noto-serif-tc-subset.woff2", "400", "normal"),
}

# 每頁可用的字面集合：EN 頁排除 Noto TC（zh 頁才載——見不變量 3）。
LATIN_FACES = {"fraunces-var.woff2", "fraunces-italic-var.woff2", "familjen.woff2",
               "plex-mono.woff2", "plex-mono-500.woff2"}
NOTO = {"noto-serif-tc-subset.woff2"}
PAGES = {
    "index.html": LATIN_FACES,
    "zh/index.html": LATIN_FACES | NOTO,
}
LINKED_CSS = ["css/site.css", "css/tokens.css"]  # 兩頁都 <link> 的外部 css

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
                        "（缺=該來源頁面此字面根本不會載入·T3 bug 家族）")
    for extra in sorted(declared - REQUIRED_FACES):
        failures.append(f"{source_name}: @font-face 有 manifest 外項 {extra}"
                        "（未審字面或 family/weight/style 寫錯）")


# ---- 讀各頁與共用 CSS -----------------------------------------------------------
linked_css = "".join((ROOT / c).read_text(encoding="utf-8") for c in LINKED_CSS)
page_scans = {}
for page in PAGES:
    scan = PageScan()
    scan.feed((ROOT / page).read_text(encoding="utf-8"))
    page_scans[page] = scan

# ---- 不變量 1：每頁消費的 CSS 精確等於 manifest ---------------------------------
for page, scan in page_scans.items():
    check_manifest(f"{page}(linked+inline)", linked_css + "".join(scan.css))

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

# ---- 不變量 3：glyph coverage（以「該頁真的宣告的字面 ∩ 允許集」為聯集）---------
cmaps = {}
for fname in {f[1] for f in REQUIRED_FACES}:
    fpath = FONT_DIR / fname
    if fpath.exists():
        cmaps[fname] = set(TTFont(fpath).getBestCmap().keys())

total_chars = 0
for page, allowed in PAGES.items():
    scan = page_scans[page]
    declared_files = {f[1] for f in parse_font_faces(linked_css + "".join(scan.css))}
    usable = allowed & declared_files          # 沒宣告的字面不得計入（假綠根源）
    union = set().union(*(cmaps[f] for f in usable if f in cmaps)) if usable else set()
    text = "".join(scan.text) + css_content_strings(linked_css + "".join(scan.css))
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
print(f"FONT-GATE OK — manifest {len(REQUIRED_FACES)} faces × {len(PAGES)} pages, "
      f"descriptors/axes match files, "
      f"{total_chars} unique glyph refs covered across {len(PAGES)} pages")
