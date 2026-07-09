/**
 * Overlay SVG 子集 parser：把使用者匯入的生產刀模 SVG（Illustrator 匯出、常見「一線一
 * `<g id="LINE##">`」包裹）轉成 Segment[]，供畫布疊圖對照使用。
 *
 * 這是獨立顯示層——不進 GenerateResult、不參與既有幾何運算。純 TS 模組：只 import
 * Segment 型別與純函式，不 import UI、不讀樣式/class（overlay 統一染洋紅，見呼叫端）。
 *
 * 支援子集（spec §5）：path（M/L/H/V/C/S/Q/T/A/Z 絕對＋相對）、line、polyline、polygon、
 * rect（無圓角）、circle、ellipse；g／元素自身的 transform（translate/scale/rotate/matrix，
 * 嵌套累乘展平）。不支援 text/image/use/嵌套 svg/rect 圓角——列警告不擋（去重計數）。
 *
 * A 指令的 endpoint→center 參數化依 W3C SVG 1.1 Implementation Notes F.6.5（一般化公式，
 * 含 x-axis-rotation 與 large-arc-flag）與 F.6.6（半徑不足時的修正）；sweep flag → ccw 映射
 * 對照 `core/path.ts` 既有的 `arcFromEndpoints`（同一 W3C 映射的簡化特例，phi=0/largeArc=0）
 * 與其測試 `tests/core/path.test.ts` 的數值錨定：sweep=1 ⟺ ccw=false（見下方 svgArcToSegments）。
 */
import type { Segment } from '@/core/geometry';
import { hasNaN } from '@/core/geometry';

export interface OverlayParseResult {
  segments: Segment[];
  warnings: string[];
  sourceInfo: { widthAttr: string | null; viewBox: string | null };
}

type ArcSegment = Extract<Segment, { kind: 'arc' }>;
type BezierSegment = Extract<Segment, { kind: 'bezier' }>;
type Point = { x: number; y: number };

/** 標準 2D 仿射矩陣：套用到點 (x,y) → (a·x+c·y+e, b·x+d·y+f)（SVG matrix() 同序）。 */
type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const TWO_PI = 2 * Math.PI;
// 等比/壞檔判準的容差：矩陣係數與圓半徑差在刀模常見數值量級（mm、0-1 縮放）下遠高於浮點雜訊。
const EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────────
// 矩陣工具
// ─────────────────────────────────────────────────────────────────────────

/** multiply(M1,M2) 對點 p 的效果＝M1(M2(p))（M2 先套用，對應 SVG「右邊先套用」語意）。 */
function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

const NUMBER_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function parseNumberList(s: string): number[] {
  return (s.match(NUMBER_RE) ?? []).map(Number);
}

/** rotate(deg) 或 rotate(deg,cx,cy)（繞點旋轉＝平移到原點旋轉再移回）。 */
function rotateMatrix(n: number[]): Matrix {
  const rad = ((n[0] ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  if (n.length < 3) return rot;
  const cx = n[1] ?? 0;
  const cy = n[2] ?? 0;
  const toOrigin: Matrix = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
  const back: Matrix = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
  return multiplyMatrix(multiplyMatrix(back, rot), toOrigin);
}

/** 單一 transform 函式名稱＋參數 → 矩陣；spec §5 子集外的函式（如 skewX/skewY）視為單位矩陣，
 *  但透過 warnFn 回報（幾何會錯位，使用者不能只看到「疊圖不準」而毫無線索）。 */
function transformFnToMatrix(name: string, n: number[], warnFn: (name: string) => void): Matrix {
  if (name === 'translate') return { a: 1, b: 0, c: 0, d: 1, e: n[0] ?? 0, f: n[1] ?? 0 };
  if (name === 'scale') {
    const sx = n[0] ?? 1;
    return { a: sx, b: 0, c: 0, d: n[1] ?? sx, e: 0, f: 0 };
  }
  if (name === 'rotate') return rotateMatrix(n);
  if (name === 'matrix') return { a: n[0] ?? 1, b: n[1] ?? 0, c: n[2] ?? 0, d: n[3] ?? 1, e: n[4] ?? 0, f: n[5] ?? 0 };
  warnFn(name);
  return IDENTITY;
}

const TRANSFORM_FN_RE = /(\w+)\s*\(([^)]*)\)/g;

/** 解析單一元素的 transform 屬性字串：多個函式左到右依序合成（左邊最後套用）。 */
function parseTransformAttr(value: string | null, warnFn: (name: string) => void): Matrix {
  if (!value) return IDENTITY;
  let acc = IDENTITY;
  for (const match of value.matchAll(TRANSFORM_FN_RE)) {
    acc = multiplyMatrix(acc, transformFnToMatrix(match[1]!, parseNumberList(match[2]!), warnFn));
  }
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────
// Arc 數學：F.6.5 endpoint→center、F.6.6 半徑修正、a2c 橢圓弧→bezier 近似
// ─────────────────────────────────────────────────────────────────────────

/** 角度正規化到 [0, 2π)（同 core/geometry.ts 的 normalizeAngle，該檔未匯出故本地重寫）。 */
function normalizeAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/** F.6.5 的 angle(u,v)：兩向量夾角，正負號取 u×v（z 分量）的符號。 */
function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const cos = Math.min(1, Math.max(-1, dot / len));
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  return sign * Math.acos(cos);
}

/**
 * F.6.5 步驟 1-3 ＋ F.6.6：由 endpoint 參數化算出 center 參數化的圓心與（必要時放大後的）rx/ry。
 * 回傳的 x1p/y1p/cxp/cyp 是「旋轉到橢圓軸對齊、原點置於弦中點」座標系下的中間值，供橢圓弧
 * 才需要的 theta1/deltaTheta 計算使用（真圓不需要，見 svgArcToSegments 的分支）。
 */
function computeArcCenter(from: Point, rx0: number, ry0: number, phi: number, largeArc: boolean, sweep: boolean, to: Point) {
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num) / den);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;
  return { cx, cy, rx, ry, x1p, y1p, cxp, cyp };
}

/** F.6.5 步驟 4：起始參數角 theta1 與有號掃角 deltaTheta（依 sweep flag 修正到對應方向）。 */
function computeThetaRange(x1p: number, y1p: number, cxp: number, cyp: number, rx: number, ry: number, sweep: boolean) {
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = vectorAngle(1, 0, ux, uy);
  let deltaTheta = vectorAngle(ux, uy, vx, vy);
  if (!sweep && deltaTheta > 0) deltaTheta -= TWO_PI;
  if (sweep && deltaTheta < 0) deltaTheta += TWO_PI;
  return { theta1, deltaTheta };
}

/**
 * 橢圓弧（cx,cy,rx,ry,phi，參數角 theta1 → theta1+deltaTheta）切成 ≤90° 段，
 * 每段用標準 a2c 公式（kappa = 4/3·tan(段角/4)）近似成三次貝茲控制點，再映射回橢圓座標。
 * rx=ry、phi=0 時即為單位圓弧的特例，供 arc Segment 在非等比 transform 下降階使用。
 */
function ellipseThetaRangeToBeziers(cx: number, cy: number, rx: number, ry: number, phi: number, theta1: number, deltaTheta: number): BezierSegment[] {
  const segCount = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const segAngle = deltaTheta / segCount;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const toEllipse = (x: number, y: number): Point => ({
    x: cx + rx * x * cosPhi - ry * y * sinPhi,
    y: cy + rx * x * sinPhi + ry * y * cosPhi,
  });

  const segments: BezierSegment[] = [];
  for (let i = 0; i < segCount; i++) {
    const a1 = theta1 + i * segAngle;
    const a2 = a1 + segAngle;
    const k = (4 / 3) * Math.tan(segAngle / 4);
    const start = toEllipse(Math.cos(a1), Math.sin(a1));
    const end = toEllipse(Math.cos(a2), Math.sin(a2));
    const c1 = toEllipse(Math.cos(a1) - k * Math.sin(a1), Math.sin(a1) + k * Math.cos(a1));
    const c2 = toEllipse(Math.cos(a2) + k * Math.sin(a2), Math.sin(a2) - k * Math.cos(a2));
    segments.push({ kind: 'bezier', x1: start.x, y1: start.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x2: end.x, y2: end.y });
  }
  return segments;
}

/**
 * SVG A 指令 → Segment[]。圓（|rx−ry|≤EPS·max(rx,ry)）→ 單一 arc；真橢圓 → a2c bezier 段。
 *
 * sweep→ccw 映射：`ccw = !sweep`。推導：SVG 規範文字定義 sweep=1 為「positive-angle-direction」
 * （即角度朝 atan2 遞增方向掃），對照 core/geometry.ts 的 angleInArc 語意「ccw=false：角度沿
 * 遞增方向掃」，兩者一致 → sweep=1 對應 ccw=false。這與 core/path.ts 的 arcFromEndpoints
 * （`ccw: sweep===0`）以及其測試 tests/core/path.test.ts 的數值錨定（sweep=1→ccw=false、
 * 90° 弧 startAngle=-π/2/endAngle=0）完全一致，是同一映射在 rx=ry=r,phi=0,largeArc=0 特例
 * 下的印證；此處是該映射的一般化版本（含任意 rx/ry/phi/largeArc）。
 */
function svgArcToSegments(from: Point, rx0: number, ry0: number, phiDeg: number, largeArc: boolean, sweep: boolean, to: Point): Segment[] {
  if (from.x === to.x && from.y === to.y) return []; // spec：起訖點重合視為無操作，不畫弧
  if (rx0 === 0 || ry0 === 0) return [{ kind: 'line', x1: from.x, y1: from.y, x2: to.x, y2: to.y }]; // F.6.6：半徑 0 退化為直線

  const phi = (phiDeg * Math.PI) / 180;
  const { cx, cy, rx, ry, x1p, y1p, cxp, cyp } = computeArcCenter(from, rx0, ry0, phi, largeArc, sweep, to);

  const isCircle = Math.abs(rx - ry) <= EPS * Math.max(rx, ry);
  if (isCircle) {
    return [
      {
        kind: 'arc',
        cx,
        cy,
        r: rx,
        startAngle: Math.atan2(from.y - cy, from.x - cx),
        endAngle: Math.atan2(to.y - cy, to.x - cx),
        ccw: !sweep,
      },
    ];
  }

  const { theta1, deltaTheta } = computeThetaRange(x1p, y1p, cxp, cyp, rx, ry, sweep);
  return ellipseThetaRangeToBeziers(cx, cy, rx, ry, phi, theta1, deltaTheta);
}

// ─────────────────────────────────────────────────────────────────────────
// Transform 展平：把已建構好的（未變換）Segment[] 套用累積矩陣
// ─────────────────────────────────────────────────────────────────────────

/** arc 的有號掃角（ccw=false 為正向遞增、ccw=true 為負向遞減），供轉 bezier 前使用；
 *  差恰為 2π 整數倍視為整圈——同 core/geometry.ts 的 angleInArc 判斷邏輯，該函式未匯出故本地重寫。 */
function arcSignedSweep(s: ArcSegment): number {
  const raw = s.ccw ? s.startAngle - s.endAngle : s.endAngle - s.startAngle;
  let mag = normalizeAngle(raw);
  if (mag < 1e-9 && Math.abs(raw) > 1e-9) mag = TWO_PI;
  return s.ccw ? -mag : mag;
}

/**
 * 矩陣線性部分是否「等比縮放＋旋轉（含鏡射）」：a²+b²＝c²+d² 且 a·c+b·d＝0（brief 判準）。
 *
 * 容差刻意用 `EPS × max(norm1,norm2,1)`（等比於矩陣係數量級）而非 brief 字面的固定 `> EPS`：
 * 固定 EPS 在座標/scale 量級大時（如 scale(1e6)）會把本應視為等比的矩陣誤判為非等比而跑去
 * 展開成 bezier（純屬多餘），量級小時又可能把非等比誤判為等比。兩種寫法只在矩陣係數量級落在
 * ~1e6 以上（brief 未定義 EPS 值本身、也不是這類刀模檔案會出現的物理量級）才會分歧，故不影響
 * 實際生產 SVG 的判定結果；換成座標尺度不變（scale-invariant）的寫法在此範圍內更穩健。
 */
function isSimilarityMatrix(m: Matrix): boolean {
  const norm1 = m.a * m.a + m.b * m.b;
  const norm2 = m.c * m.c + m.d * m.d;
  const dot = m.a * m.c + m.b * m.d;
  const scale = Math.max(norm1, norm2, 1);
  return Math.abs(norm1 - norm2) <= EPS * scale && Math.abs(dot) <= EPS * scale;
}

function transformLine(s: Extract<Segment, { kind: 'line' }>, m: Matrix): Segment {
  const p1 = applyMatrix(m, { x: s.x1, y: s.y1 });
  const p2 = applyMatrix(m, { x: s.x2, y: s.y2 });
  return { kind: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

function transformBezier(s: BezierSegment, m: Matrix): BezierSegment {
  const p1 = applyMatrix(m, { x: s.x1, y: s.y1 });
  const c1 = applyMatrix(m, { x: s.c1x, y: s.c1y });
  const c2 = applyMatrix(m, { x: s.c2x, y: s.c2y });
  const p2 = applyMatrix(m, { x: s.x2, y: s.y2 });
  return { kind: 'bezier', x1: p1.x, y1: p1.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x2: p2.x, y2: p2.y };
}

/**
 * arc 在非等比矩陣下先展成 bezier 再變換（bezier 對任意仿射變換封閉，line/bezier 皆同）；
 * 等比矩陣下直接變換圓心/半徑/角度：半徑 ×scale、角度加旋轉量 φ=atan2(b,a)，
 * 負 determinant（鏡射）時角度映射改為 φ−θ（方向反轉）且 ccw 翻轉——見模組頂部映射推導。
 */
function transformArc(s: ArcSegment, m: Matrix): Segment[] {
  if (!isSimilarityMatrix(m)) {
    const beziers = ellipseThetaRangeToBeziers(s.cx, s.cy, s.r, s.r, 0, s.startAngle, arcSignedSweep(s));
    return beziers.map((b) => transformBezier(b, m));
  }
  const scale = Math.sqrt(m.a * m.a + m.b * m.b);
  const phi = Math.atan2(m.b, m.a);
  const det = m.a * m.d - m.b * m.c;
  const center = applyMatrix(m, { x: s.cx, y: s.cy });
  const mapAngle = (theta: number) => (det < 0 ? phi - theta : theta + phi);
  return [
    {
      kind: 'arc',
      cx: center.x,
      cy: center.y,
      r: s.r * scale,
      startAngle: mapAngle(s.startAngle),
      endAngle: mapAngle(s.endAngle),
      ccw: det < 0 ? !s.ccw : s.ccw,
    },
  ];
}

function transformSegment(s: Segment, m: Matrix): Segment[] {
  if (s.kind === 'line') return [transformLine(s, m)];
  if (s.kind === 'bezier') return [transformBezier(s, m)];
  return transformArc(s, m);
}

function transformSegments(segs: Segment[], m: Matrix): Segment[] {
  return segs.flatMap((s) => transformSegment(s, m));
}

// ─────────────────────────────────────────────────────────────────────────
// Path `d` 字串 tokenizer
// ─────────────────────────────────────────────────────────────────────────

type PathToken = { cmd: string; args: number[] };

const PATH_ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const PATH_CMD_RE = /[MLHVCSQTAZmlhvcsqtaz]/;
const NUMBER_STICKY_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;

/** 從字串 d 的位置 start 起，讀 count 個數字（跳過中間的空白/逗號分隔）。 */
function readNumbers(d: string, start: number, count: number): { args: number[]; next: number } {
  const args: number[] = [];
  let i = start;
  for (let k = 0; k < count; k++) {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
    NUMBER_STICKY_RE.lastIndex = i;
    const m = NUMBER_STICKY_RE.exec(d);
    // regex 結構上不可能配到空字串或孤立正負號（強制要求至少一位數字，見測試腳本驗證）：
    // 配不到即代表此處不是數字起點，無條件視為「數字不足」而停止。
    if (!m) break;
    args.push(Number(m[0]));
    i = NUMBER_STICKY_RE.lastIndex;
  }
  return { args, next: i };
}

/**
 * A/a 指令專用參數讀取：7 個參數中第 4/5 個（largeArc/sweep flag，索引 3/4）依 SVG path
 * grammar 的 flag production 是「單一字元、只能是 0 或 1」，不能走通用數字 regex——否則像
 * `1025,25` 這種合法 compact 寫法（largeArc=1、sweep=0、x=25 緊貼無分隔符）會被貪婪匹配成
 * 一個數字 1025，使參數總數不足 7 而整段 A 被 tokenizePathData 判為壞檔丟棄（見呼叫端）。
 * 其餘 5 個參數（rx/ry/x-axis-rotation/x/y）維持一般數字讀法（可含小數/負號/科學記號）。
 */
function readArcArgs(d: string, start: number): { args: number[]; next: number } {
  const args: number[] = [];
  let i = start;
  for (let k = 0; k < 7; k++) {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
    if (k === 3 || k === 4) {
      if (i >= d.length || (d[i] !== '0' && d[i] !== '1')) break;
      args.push(Number(d[i]));
      i++;
      continue;
    }
    NUMBER_STICKY_RE.lastIndex = i;
    const m = NUMBER_STICKY_RE.exec(d);
    if (!m) break;
    args.push(Number(m[0]));
    i = NUMBER_STICKY_RE.lastIndex;
  }
  return { args, next: i };
}

/**
 * path `d` 字串 → 指令 token 列表；同字母重複出現時可省略字母（隱式重複沿用前一指令），
 * M 的隱式重複視為 L（spec：M 後續座標對＝L）。壞檔容錯：數字不足一組或無法前進即停止
 * （不 throw，回傳已讀到的 token，避免死迴圈）；同時回傳 `rest`＝停止點之後未消費的原始字串，
 * 供呼叫端判斷是否需要「部分內容未匯入」警告（見 pathToSegments）。
 */
function tokenizePathData(d: string): { tokens: PathToken[]; rest: string } {
  const tokens: PathToken[] = [];
  let i = 0;
  let currentCmd = '';
  while (i < d.length) {
    const ch = d[i]!;
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (PATH_CMD_RE.test(ch)) {
      currentCmd = ch;
      i++;
      if (PATH_ARITY[currentCmd.toUpperCase()] === 0) {
        tokens.push({ cmd: currentCmd, args: [] });
        currentCmd = ''; // Z 之後必須是新指令字母，否則視為壞檔尾段
      }
      continue;
    }
    if (!currentCmd) break;
    const arity = PATH_ARITY[currentCmd.toUpperCase()]!;
    const { args, next } = currentCmd.toUpperCase() === 'A' ? readArcArgs(d, i) : readNumbers(d, i, arity);
    if (args.length < arity || next === i) break;
    tokens.push({ cmd: currentCmd, args });
    i = next;
    if (currentCmd === 'M') currentCmd = 'L';
    else if (currentCmd === 'm') currentCmd = 'l';
  }
  return { tokens, rest: d.slice(i) };
}

// ─────────────────────────────────────────────────────────────────────────
// Path 指令狀態機
// ─────────────────────────────────────────────────────────────────────────

type PathState = {
  cursor: Point;
  subpathStart: Point;
  lastCmd: string | null;
  lastControl: Point | null;
  segments: Segment[];
};

function reflectPoint(p0: Point, ctrl: Point): Point {
  return { x: 2 * p0.x - ctrl.x, y: 2 * p0.y - ctrl.y };
}

function applyMoveOrLine(state: PathState, args: number[], relative: boolean, isMove: boolean): void {
  const base = relative ? state.cursor : { x: 0, y: 0 };
  const end = { x: base.x + args[0]!, y: base.y + args[1]! };
  if (isMove) {
    state.cursor = end;
    state.subpathStart = end;
    return;
  }
  state.segments.push({ kind: 'line', x1: state.cursor.x, y1: state.cursor.y, x2: end.x, y2: end.y });
  state.cursor = end;
}

function applyAxisLine(state: PathState, args: number[], relative: boolean, axis: 'x' | 'y'): void {
  const value = args[0]!;
  const p0 = state.cursor;
  const end = axis === 'x' ? { x: relative ? p0.x + value : value, y: p0.y } : { x: p0.x, y: relative ? p0.y + value : value };
  state.segments.push({ kind: 'line', x1: p0.x, y1: p0.y, x2: end.x, y2: end.y });
  state.cursor = end;
}

/** C（isReflect=false）與 S（isReflect=true，c1 反射前一個 C/S 的 c2；非 C/S 銜接時反射點＝當前點）。 */
function applyCubic(state: PathState, args: number[], relative: boolean, isReflect: boolean): void {
  const p0 = state.cursor;
  const base = relative ? p0 : { x: 0, y: 0 };
  const hasPrevCubic = state.lastCmd === 'C' || state.lastCmd === 'S';
  const c1 = isReflect ? reflectPoint(p0, hasPrevCubic ? state.lastControl! : p0) : { x: base.x + args[0]!, y: base.y + args[1]! };
  const rest = isReflect ? args : args.slice(2);
  const c2 = { x: base.x + rest[0]!, y: base.y + rest[1]! };
  const end = { x: base.x + rest[2]!, y: base.y + rest[3]! };
  state.segments.push({ kind: 'bezier', x1: p0.x, y1: p0.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x2: end.x, y2: end.y });
  state.cursor = end;
  state.lastControl = c2;
}

/** Q（isReflect=false）與 T（isReflect=true，反射前一個 Q/T 的控制點）；二次→三次升階：
 *  c1=p0+2/3(q−p0)、c2=p3+2/3(q−p3)（brief 公式，等價於標準 quadratic-to-cubic degree elevation）。 */
function applyQuad(state: PathState, args: number[], relative: boolean, isReflect: boolean): void {
  const p0 = state.cursor;
  const base = relative ? p0 : { x: 0, y: 0 };
  const hasPrevQuad = state.lastCmd === 'Q' || state.lastCmd === 'T';
  const q = isReflect ? reflectPoint(p0, hasPrevQuad ? state.lastControl! : p0) : { x: base.x + args[0]!, y: base.y + args[1]! };
  const endArgs = isReflect ? args : args.slice(2);
  const end = { x: base.x + endArgs[0]!, y: base.y + endArgs[1]! };
  const c1 = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) };
  const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
  state.segments.push({ kind: 'bezier', x1: p0.x, y1: p0.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x2: end.x, y2: end.y });
  state.cursor = end;
  state.lastControl = q;
}

function applyClose(state: PathState): void {
  const p0 = state.cursor;
  const start = state.subpathStart;
  if (p0.x !== start.x || p0.y !== start.y) {
    state.segments.push({ kind: 'line', x1: p0.x, y1: p0.y, x2: start.x, y2: start.y });
  }
  state.cursor = start;
}

function applyArcCommand(state: PathState, args: number[], relative: boolean): void {
  const p0 = state.cursor;
  const base = relative ? p0 : { x: 0, y: 0 };
  const end = { x: base.x + args[5]!, y: base.y + args[6]! };
  const segs = svgArcToSegments(p0, args[0]!, args[1]!, args[2]!, args[3] !== 0, args[4] !== 0, end);
  state.segments.push(...segs);
  state.cursor = end;
}

function applyToken(state: PathState, t: PathToken): void {
  const upper = t.cmd.toUpperCase();
  const relative = t.cmd !== upper;
  if (upper === 'M') applyMoveOrLine(state, t.args, relative, true);
  else if (upper === 'L') applyMoveOrLine(state, t.args, relative, false);
  else if (upper === 'H') applyAxisLine(state, t.args, relative, 'x');
  else if (upper === 'V') applyAxisLine(state, t.args, relative, 'y');
  else if (upper === 'C') applyCubic(state, t.args, relative, false);
  else if (upper === 'S') applyCubic(state, t.args, relative, true);
  else if (upper === 'Q') applyQuad(state, t.args, relative, false);
  else if (upper === 'T') applyQuad(state, t.args, relative, true);
  else if (upper === 'A') applyArcCommand(state, t.args, relative);
  else if (upper === 'Z') applyClose(state);
  // 記錄本次指令字母，供下一次 S/T 判斷「前一指令是否同家族」（C/S 一組、Q/T 一組）；
  // 非該家族的字母（含 Z）彼此等價——只要不是 C/S/Q/T，hasPrevCubic/hasPrevQuad 皆為
  // false，故不需特判、直接記錄 upper 即可（見 applyCubic/applyQuad 的判斷式）。
  state.lastCmd = upper;
}

function runPathCommands(tokens: PathToken[]): Segment[] {
  const state: PathState = { cursor: { x: 0, y: 0 }, subpathStart: { x: 0, y: 0 }, lastCmd: null, lastControl: null, segments: [] };
  for (const t of tokens) applyToken(state, t);
  return state.segments;
}

// ─────────────────────────────────────────────────────────────────────────
// 元素 → 未變換 Segment[]
// ─────────────────────────────────────────────────────────────────────────

function num(el: Element, name: string, fallback = 0): number {
  const v = el.getAttribute(name);
  return v === null ? fallback : Number(v);
}

/** 若 tokenizer 中途卡住（壞檔），`d` 尾端會有未消費的非空白殘留——這代表路徑後半段被
 *  靜默丟棄，須警告（去重計數於呼叫端，見 makeWarningCollector 的「未匯入」樣板）。 */
function pathToSegments(el: Element, warn: (tag: string) => void): Segment[] {
  const { tokens, rest } = tokenizePathData(el.getAttribute('d') ?? '');
  if (rest.trim() !== '') warn('path 資料不完整，部分內容');
  return runPathCommands(tokens);
}

function lineToSegments(el: Element): Segment[] {
  return [{ kind: 'line', x1: num(el, 'x1'), y1: num(el, 'y1'), x2: num(el, 'x2'), y2: num(el, 'y2') }];
}

function parsePoints(el: Element): Point[] {
  const nums = parseNumberList(el.getAttribute('points') ?? '');
  const pts: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
  return pts;
}

/** polyline（closed=false）/ polygon（closed=true，補一條回起點的閉合線）。 */
function polylineToSegments(el: Element, closed: boolean): Segment[] {
  const pts = parsePoints(el);
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    segs.push({ kind: 'line', x1: pts[i]!.x, y1: pts[i]!.y, x2: pts[i + 1]!.x, y2: pts[i + 1]!.y });
  }
  if (closed && pts.length > 1) {
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    segs.push({ kind: 'line', x1: last.x, y1: last.y, x2: first.x, y2: first.y });
  }
  return segs;
}

function rectToSegments(el: Element, warn: (tag: string) => void): Segment[] {
  const x = num(el, 'x');
  const y = num(el, 'y');
  const w = num(el, 'width');
  const h = num(el, 'height');
  if (num(el, 'rx') > 0 || num(el, 'ry') > 0) warn('rect 圓角（rx/ry）');
  const p = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  return [0, 1, 2, 3].map((i) => ({ kind: 'line' as const, x1: p[i]!.x, y1: p[i]!.y, x2: p[(i + 1) % 4]!.x, y2: p[(i + 1) % 4]!.y }));
}

/**
 * 圓 → 兩個半圓 arc（0→π、π→2π，ccw=false；同 cx/cy/r）。
 *
 * FX1（Slice 3 final review）：修前用單一 startAngle=0/endAngle=2π 的「完整圓」arc——這是
 * `core/geometry.ts` 的完整圓語意（角度差恰為 2π 整數倍），bounds/hit-test 等純數學運算認得，
 * 但 Canvas 渲染走的是 `segmentsToSvgD`（`core/path.ts`）投影成 SVG `A` 指令：完整圓的起訖點
 * 座標算出來完全相同（`cx+r·cos(0)`＝`cx+r·cos(2π)`），使 `A` 指令的終點跟前面的 `M` 起點
 * 重合——依 SVG 1.1 規範，起訖點重合的 elliptical arc 是退化情形，不畫任何東西。實測探針
 * （fixture `cx=5,cy=5,r=3`）證實：`segmentsToSvgD` 產出 `"M8.00,5.00 A3.00,3.00 0 0,1
 * 8.00,5.00"`——`M` 與 `A` 終點座標逐位元相同，零渲染。結果是圓形完整參與 rawBounds／對齊
 * 計算，畫布上卻完全隱形。
 *
 * 拆成兩個半圓（各自起訖點不重合）後，兩段合起來的視覺／包絡與原本的完整圓等價，`A` 指令
 * 才畫得出東西。額外副作用（有意保留，非臆測）：校準模式下圓孔本身可被點選（每個半圓的
 * hit-test 折線非零長）；且每個半圓的「弦長」（`overlay/state.ts` 的 `segmentChordLength`）
 * 恰為直徑（起訖點是圓上正對的兩點）——校準時點圓可直接拿直徑當量測基準，見該檔
 * `calibrateScale` 文件補述。
 */
function circleToSegments(el: Element): Segment[] {
  const cx = num(el, 'cx');
  const cy = num(el, 'cy');
  const r = num(el, 'r');
  return [
    { kind: 'arc', cx, cy, r, startAngle: 0, endAngle: Math.PI, ccw: false },
    { kind: 'arc', cx, cy, r, startAngle: Math.PI, endAngle: TWO_PI, ccw: false },
  ];
}

function ellipseToSegments(el: Element): Segment[] {
  return ellipseThetaRangeToBeziers(num(el, 'cx'), num(el, 'cy'), num(el, 'rx'), num(el, 'ry'), 0, 0, TWO_PI);
}

// ─────────────────────────────────────────────────────────────────────────
// 元素遍歷（g／transform 展平、未支援元素警告）
// ─────────────────────────────────────────────────────────────────────────

const UNSUPPORTED_TAGS = new Set(['text', 'image', 'use', 'svg']);

/** 三類走訪期間會回報的警告，各自獨立計數／措辭（見 parseOverlaySvgInner 的收集器）：
 *  unsupported＝未支援 tag／rect 圓角／path 資料不完整（共用「未匯入」樣板）；
 *  transformFn＝transform 子集外函式名（如 skewX，仍以 identity 匯入元素）；
 *  classStyle＝元素帶 class/style 屬性（純計數，不分 key，樣式一律不套用）。 */
type WarnFns = {
  unsupported: (tag: string) => void;
  transformFn: (name: string) => void;
  classStyle: () => void;
};

function shapeToLocalSegments(el: Element, tag: string, warn: (tag: string) => void): Segment[] | null {
  if (tag === 'path') return pathToSegments(el, warn);
  if (tag === 'line') return lineToSegments(el);
  if (tag === 'polyline') return polylineToSegments(el, false);
  if (tag === 'polygon') return polylineToSegments(el, true);
  if (tag === 'rect') return rectToSegments(el, warn);
  if (tag === 'circle') return circleToSegments(el);
  if (tag === 'ellipse') return ellipseToSegments(el);
  return null; // 未知標籤（defs/title/clipPath 等）：靜默略過、不遞迴其子節點
}

/** 遞迴走訪：`<g>` 累乘 transform 後遞迴子節點（FX4，Slice 3 final review：`<g>` 自身帶
 *  class/style 屬性者也計警告，不只子節點內的 shape，見下方該分支註解）；已知形狀元素套用
 *  展平矩陣後收進 out（帶 class/style 屬性者計警告但仍匯入，全視為刀線）；text/image/use/
 *  嵌套 svg 計警告、不遞迴其內容。 */
function walkNode(el: Element, matrix: Matrix, warn: WarnFns, out: Segment[]): void {
  const tag = el.tagName.toLowerCase();
  if (UNSUPPORTED_TAGS.has(tag)) {
    warn.unsupported(`<${tag}>`);
    return;
  }

  const composed = multiplyMatrix(matrix, parseTransformAttr(el.getAttribute('transform'), warn.transformFn));

  if (tag === 'g') {
    // FX4（Slice 3 final review）：修前這個分支在檢查 class/style 之前就遞迴＋return，
    // 永遠不會走到下面 shape 分支才有的檢查——Illustrator 圖層樣式（含 display:none）
    // 常掛在 `<g>` 上（比掛在單一 shape 上更高頻的匯出模式），修前完全不會觸發警告，
    // 使用者毫無線索某個圖層可能被 CSS 隱藏卻仍被當刀線匯入。g 與 shape 各自獨立計數
    // （巢狀時皆帶 class 會計 2 次，非合併成 1 次），與既有「class／style 共用同一計數，
    // 不分別計 key」的去重規則不衝突——那條規則是「class 跟 style 兩個屬性名不分別計」，
    // 不是「巢狀元素合併計」。
    if (el.hasAttribute('class') || el.hasAttribute('style')) warn.classStyle();
    for (const child of Array.from(el.children)) walkNode(child, composed, warn, out);
    return;
  }

  const local = shapeToLocalSegments(el, tag, warn.unsupported);
  if (local) {
    if (el.hasAttribute('class') || el.hasAttribute('style')) warn.classStyle();
    out.push(...transformSegments(local, composed));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 警告收集與頂層入口
// ─────────────────────────────────────────────────────────────────────────

/** 去重計數收集器：同 key 疊加次數，輸出依 format(key,n) 轉人話訊息（預設「<tag> ×N 未匯入」
 *  樣板，供未支援 tag／rect 圓角／path 資料不完整共用；transform 函式警告另傳 format 覆寫措辭）。 */
function makeWarningCollector(format: (key: string, n: number) => string = (key, n) => `${key} ×${n} 未匯入`) {
  const counts = new Map<string, number>();
  return {
    add: (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1),
    toMessages: () => [...counts.entries()].map(([key, n]) => format(key, n)),
  };
}

/** 過濾含 NaN 座標的 segment（生產 SVG 常見寫法如 `x2="10mm"` 讓 Number() 產生 NaN；帶 NaN 的
 *  幾何寧可丟棄也不能讓「疊圖對照」呈現錯誤位置或憑空消失的線卻毫無提示）。在收集層（所有元素
 *  展平後）統一過濾一次即可，不需每個 num() 呼叫點各自處理。回傳乾淨 segments 與丟棄數。 */
function filterNaNSegments(segs: Segment[]): { clean: Segment[]; dropped: number } {
  const clean = segs.filter((s) => !hasNaN([s]));
  return { clean, dropped: segs.length - clean.length };
}

/** 每次呼叫回傳新物件（不共用單一 reference）：避免呼叫端萬一原地改動 sourceInfo 時互相汙染。 */
function emptySourceInfo(): OverlayParseResult['sourceInfo'] {
  return { widthAttr: null, viewBox: null };
}

function parseOverlaySvgInner(svgText: string): OverlayParseResult {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    return { segments: [], warnings: ['SVG 解析失敗：不是合法的 SVG 文件'], sourceInfo: emptySourceInfo() };
  }

  const collector = makeWarningCollector();
  const transformCollector = makeWarningCollector((name, n) => `transform ${name} 不支援，已忽略 ×${n}`);
  let classStyleCount = 0;
  const warn: WarnFns = {
    unsupported: collector.add,
    transformFn: transformCollector.add,
    classStyle: () => {
      classStyleCount++;
    },
  };

  const rawSegments: Segment[] = [];
  for (const child of Array.from(root.children)) {
    walkNode(child, IDENTITY, warn, rawSegments);
  }
  const { clean, dropped } = filterNaNSegments(rawSegments);

  const warnings = [
    ...collector.toMessages(),
    ...transformCollector.toMessages(),
    ...(dropped > 0 ? [`${dropped} 個線段座標無法解析，已略過`] : []),
    ...(classStyleCount > 0 ? [`${classStyleCount} 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）`] : []),
  ];

  return {
    segments: clean,
    warnings,
    sourceInfo: { widthAttr: root.getAttribute('width'), viewBox: root.getAttribute('viewBox') },
  };
}

/** 匯入生產刀模 SVG → Segment[]＋警告清單＋校準用 sourceInfo。壞檔（含非 XML）不 throw，回空 segments＋警告。 */
export function parseOverlaySvg(svgText: string): OverlayParseResult {
  try {
    return parseOverlaySvgInner(svgText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { segments: [], warnings: [`SVG 解析失敗：${msg}`], sourceInfo: emptySourceInfo() };
  }
}
