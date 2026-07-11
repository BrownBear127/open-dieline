/**
 * 拼版輪廓投影間距（profile-aware spacing）——共用幾何過濾、四向 1D 輪廓包絡與
 * gap-aware minStride（spec F1／F2b，`docs/specs/2026-07-11-imposition-profile-spacing.md`）。
 *
 * 純 TS 模組，不 import React、`export/*`、或 `boxes/*` 任何模組（與 `core/imposition.ts`
 * 同一紀律）——只吃 `Segment[]`／`GenerateResult` 這類呼叫端已經準備好的資料，不知道
 * 「盒型」本身怎麼生成。座標單位一律 mm。
 *
 * **保守界原則（本模組的正確性軸心，spec F1）**：任何離散化／曲線近似的誤差必須朝
 * 「stride 變大（間距變大）」方向——寧可少省、不可撞刀。三種線型的保守化策略：
 *   - `line`：解析極值（端點＋線段與槽邊界的交點），無點取樣、無近似。
 *   - `arc`：以 `segmentBounds`（`core/geometry.ts` 既有、含 0/90/180/270° 切點的保守 bbox）
 *     為代表，貢獻給 bbox 重疊到的**每一個**槽帶——spec F1 明文允許的二擇一保守替代
 *     （見 `contributeArc` 的理由；與逐槽解析交點的另一案相比更簡單、bug 面更小，task-1
 *     report 有完整取捨記錄）。
 *   - `bezier`：逐槽取控制點凸包（`convexHull`）與該槽帶交集的極值——不得用整體凸包
 *     bounds（spec 明文禁止），故與 arc 不同，逐槽 clip（`clipConvexPolygonToAxisRange`）。
 *
 * 槽邊界雙邊歸屬（恰落在邊界上的極值點同時貢獻左右兩槽）不是靠偵測「座標是否恰為 0.5 的
 * 倍數」這種脆弱的浮點判斷達成——核心機制是逐槽 clip 的**閉區間**「非空」判斷（`clipLo >
 * clipHi` 才算空，`clipLo === clipHi` 這種單點觸碰視為非空且有效）：一個 segment 在恰好
 * 觸到某槽邊界的單一點，會讓左右兩槽各自的 clip 範圍都收斂成「單點閉區間」而非空，因此
 * 兩槽都會拿到那個點的值。`candidateSlotRange` 的左右各一槽緩衝只是額外的搜尋範圍保險
 * （防浮點噪音讓 `floor()` 選錯候選槽），本身不是雙邊歸屬成立的必要條件——用「移除緩衝」
 * 和「把閉區間判斷改嚴格（`clipLo >= clipHi` 才算非空）」兩種突變分別驗證過：只有後者會讓
 * 槽邊界雙歸屬測試變紅，前者不會（開發紀錄 記錄了這個 mutation testing 過程）。
 */

import type { Segment } from '@/core/geometry';
import { segmentBounds, segmentsBounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult, LineType } from '@/core/types';

type LineSeg = Extract<Segment, { kind: 'line' }>;
type ArcSeg = Extract<Segment, { kind: 'arc' }>;
type BezierSeg = Extract<Segment, { kind: 'bezier' }>;

// ─────────────────────────────────────────────────────────────────────────
// 共用過濾函式（plan T1「core 共用過濾函式」——bounds／profile／preview 三消費者同源）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 算「拼版／profile 用途」幾何時該看的線型——正面表列 `cut`/`crease`/`halfcut`。
 *
 * 刻意不是 `core/bounds.ts` 的 `DIMENSION_LINE_TYPES`（排除表列，`manufacturingBounds` 用
 * `!DIMENSION_LINE_TYPES.has(...)`）的鏡射寫法：這裡是本功能（拼版 bounds／輪廓包絡／
 * 預覽）專屬的正面表列，`manufacturingBounds` 的排除表列規則零觸碰（它的 bleed 排除語意
 * 用途不同——疊圖對齊／匯出檔名——spec F2b 呼叫鏈明文「manufacturingBounds 全域語意零
 * 觸碰」）。v1 目前沒有任何盒型會產生 `bleed`／`annotation` 路徑（RTE 的 `no-bleed`
 * 不變式即為此），所以兩份過濾規則現在算出來的集合相等；正面表列在未來新增 `bleed`
 * 支援時仍會自動排除它，不需要額外維護，這正是「同源化為防未來分歧」的意思（spec F2b）。
 */
export const PROFILE_GEOMETRY_TYPES: ReadonlySet<LineType> = new Set(['cut', 'crease', 'halfcut']);

/**
 * 共用過濾：`cut`/`crease`/`halfcut` ＋可選 `piece.pathIds` → paths 子集（plan T1）。
 *
 * 簽章刻意對齊 `manufacturingBounds(result, piece?)`（`core/bounds.ts`）——呼叫端已經在用
 * 那個模式取得 `GenerateResult`／`DielinePiece`，這裡不需要另一種取值方式。回傳
 * `DielinePath[]`（不是攤平的 `Segment[]`）：讓不同消費者各自決定要不要攤平——
 * `computeProfileStrides` 需要攤平的 segments（`.flatMap(p => p.segments)`），未來的預覽
 * 消費者可能還需要 path 本身的 `type`/`tags` 做視覺分層。
 */
export function manufacturingPaths(result: GenerateResult, piece?: DielinePiece): DielinePath[] {
  const pathIdSet = piece ? new Set(piece.pathIds) : null;
  return result.paths.filter((p) => (pathIdSet === null || pathIdSet.has(p.id)) && PROFILE_GEOMETRY_TYPES.has(p.type));
}

// ─────────────────────────────────────────────────────────────────────────
// 幾何小工具（凸包／半平面裁切——bezier 保守界專用，spec F1）
// ─────────────────────────────────────────────────────────────────────────

interface Pt {
  x: number;
  y: number;
}

type Axis = 'x' | 'y';

/** 分槽用的座標軸讀值——x-pass 沿 x 分槽，y-pass 沿 y 分槽。 */
function coordOf(p: Pt, axis: Axis): number {
  return axis === 'x' ? p.x : p.y;
}

/** 分槽的「值」軸讀值——與 `coordOf` 互補（x-pass 的值是 y，y-pass 的值是 x）。 */
function valueOf(p: Pt, axis: Axis): number {
  return axis === 'x' ? p.y : p.x;
}

function crossProduct(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function dedupePoints(points: Pt[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of points) {
    const key = `${p.x}|${p.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * Andrew's monotone chain：≤4 個 bezier 控制點的凸包（spec F1 bezier 保守界的第一步）。
 * 「曲線 ⊆ 控制點凸包」是 bezier 的標準性質，不論控制點原始連接順序本身是否為凸。
 * 輸入 ≤2 相異點時提前回傳（3/4 點的一般算法對這種退化輸入沒有意義）；3/4 點共線時
 * 演算法自然收斂成 2 點（首尾端點），已用手算驗證，見 開發紀錄。
 */
function convexHull(points: Pt[]): Pt[] {
  const pts = dedupePoints(points).sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length <= 2) return pts;

  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function intersectAtAxisBoundary(a: Pt, b: Pt, axis: Axis, boundary: number): Pt {
  const ac = coordOf(a, axis);
  const bc = coordOf(b, axis);
  const t = ac === bc ? 0 : (boundary - ac) / (bc - ac);
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** Sutherland-Hodgman 對凸多邊形做單一半平面裁切（`keepGE`＝保留 coord≥boundary 側，否則 ≤）。 */
function clipHalfPlane(poly: Pt[], axis: Axis, boundary: number, keepGE: boolean): Pt[] {
  if (poly.length === 0) return [];
  const inside = (p: Pt) => (keepGE ? coordOf(p, axis) >= boundary : coordOf(p, axis) <= boundary);
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const prev = poly[(i - 1 + poly.length) % poly.length]!;
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn !== prevIn) {
      out.push(intersectAtAxisBoundary(prev, cur, axis, boundary));
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/** 凸多邊形裁切到 `[lo,hi]` 的座標帶（沿 `axis`）——bezier 逐槽 clip 用（spec F1，不得用整體凸包 bounds）。 */
function clipConvexPolygonToAxisRange(poly: Pt[], axis: Axis, lo: number, hi: number): Pt[] {
  return clipHalfPlane(clipHalfPlane(poly, axis, lo, true), axis, hi, false);
}

// ─────────────────────────────────────────────────────────────────────────
// 槽索引與逐 segment 貢獻（spec F1「四向 1D 輪廓包絡」）
// ─────────────────────────────────────────────────────────────────────────

/** 槽寬（mm）——愈細愈貼近真實輪廓；0.5mm 遠小於刀模常見特徵尺度（spec F1）。 */
const SLOT_SIZE_MM = 0.5;

/** 單軸槽數上限——超過時整數合併成粗槽（巢狀邊界，spec F1；見 `mergeIntoSlotLimit`）。 */
const MAX_SLOTS_PER_AXIS = 4096;

function clampSlotIndex(i: number, slotCount: number): number {
  return Math.min(slotCount - 1, Math.max(0, i));
}

/**
 * 一個 segment 可能貢獻到的槽索引範圍——多留左右各一槽當搜尋緩衝，防浮點噪音讓
 * `floor()` 選到的候選範圍差一槽（真正決定「這一槽算不算重疊」的是各 `contribute*`
 * 函式的閉區間 clip 非空判斷，見檔頭「槽邊界雙邊歸屬」說明；這裡的緩衝只是不讓候選範圍
 * 本身漏掉該檢查的槽）。
 */
function candidateSlotRange(cMin: number, cMax: number, slotCount: number, slotSize: number): { first: number; last: number } {
  const first = clampSlotIndex(Math.floor(cMin / slotSize) - 1, slotCount);
  const last = clampSlotIndex(Math.floor(cMax / slotSize) + 1, slotCount);
  return { first, last };
}

/** 槽 i 的座標範圍（`extent`＝這一軸的總長度；最後一槽用實際邊界，可能比 `slotSize` 窄）。 */
function slotRange(i: number, slotCount: number, slotSize: number, extent: number): { lo: number; hi: number } {
  const lo = i * slotSize;
  const hi = i === slotCount - 1 ? extent : (i + 1) * slotSize;
  return { lo, hi };
}

function updateSlot(slotMin: number[], slotMax: number[], i: number, vLo: number, vHi: number): void {
  if (vLo < slotMin[i]!) slotMin[i] = vLo;
  if (vHi > slotMax[i]!) slotMax[i] = vHi;
}

/** `line`：解析極值——線段端點＋與槽邊界的交點，皆為解析座標，非點取樣（spec F1）。 */
function contributeLine(slotMin: number[], slotMax: number[], axis: Axis, extent: number, seg: LineSeg): void {
  const a: Pt = { x: seg.x1, y: seg.y1 };
  const b: Pt = { x: seg.x2, y: seg.y2 };
  const ac = coordOf(a, axis);
  const bc = coordOf(b, axis);
  const cMin = Math.min(ac, bc);
  const cMax = Math.max(ac, bc);
  const slotCount = slotMin.length;
  const { first, last } = candidateSlotRange(cMin, cMax, slotCount, SLOT_SIZE_MM);

  for (let i = first; i <= last; i++) {
    const { lo: slotLo, hi: slotHi } = slotRange(i, slotCount, SLOT_SIZE_MM, extent);
    const clipLo = Math.max(cMin, slotLo);
    const clipHi = Math.min(cMax, slotHi);
    if (clipLo > clipHi) continue;

    if (ac === bc) {
      // 沿此軸退化（線段垂直於 coord 軸）：value 端點的完整範圍都落在這一槽。
      updateSlot(slotMin, slotMax, i, Math.min(valueOf(a, axis), valueOf(b, axis)), Math.max(valueOf(a, axis), valueOf(b, axis)));
      continue;
    }

    const valueAt = (c: number) => {
      const t = (c - ac) / (bc - ac);
      return valueOf(a, axis) + t * (valueOf(b, axis) - valueOf(a, axis));
    };
    const v1 = valueAt(clipLo);
    const v2 = valueAt(clipHi);
    updateSlot(slotMin, slotMax, i, Math.min(v1, v2), Math.max(v1, v2));
  }
}

/**
 * `arc`：以 `segmentBounds`（既有、含 0/90/180/270° 切點的保守 bbox）為代表，貢獻給 bbox
 * 重疊到的每一個槽帶（spec F1 明文允許的二擇一保守替代——「bbox 與其重疊的每個槽帶都貢獻
 * 該 bbox 的 y 極值」）。這保證了「弧穿槽但端點/切點都不在該槽」（v1.2·H2）不會漏算：
 * 判斷式是純粹的座標區間重疊，不依賴弧上任何特定候選點是否落在該槽內。
 */
function contributeArc(slotMin: number[], slotMax: number[], axis: Axis, extent: number, seg: ArcSeg): void {
  const bbox = segmentBounds(seg);
  const cMin = axis === 'x' ? bbox.minX : bbox.minY;
  const cMax = axis === 'x' ? bbox.maxX : bbox.maxY;
  const vLo = axis === 'x' ? bbox.minY : bbox.minX;
  const vHi = axis === 'x' ? bbox.maxY : bbox.maxX;
  const slotCount = slotMin.length;
  const { first, last } = candidateSlotRange(cMin, cMax, slotCount, SLOT_SIZE_MM);

  for (let i = first; i <= last; i++) {
    const { lo: slotLo, hi: slotHi } = slotRange(i, slotCount, SLOT_SIZE_MM, extent);
    const clipLo = Math.max(cMin, slotLo);
    const clipHi = Math.min(cMax, slotHi);
    if (clipLo > clipHi) continue;
    updateSlot(slotMin, slotMax, i, vLo, vHi);
  }
}

/**
 * `bezier`：逐槽取控制點凸包與該槽帶交集的 y（或 x）極值——凸包 ⊇ 曲線＝保守；
 * 不得用整體凸包 bounds（spec F1 明文禁止，與 arc 的 bbox-替代不同，見檔頭）。
 */
function contributeBezier(slotMin: number[], slotMax: number[], axis: Axis, extent: number, seg: BezierSeg): void {
  const hull = convexHull([
    { x: seg.x1, y: seg.y1 },
    { x: seg.c1x, y: seg.c1y },
    { x: seg.c2x, y: seg.c2y },
    { x: seg.x2, y: seg.y2 },
  ]);
  const coords = hull.map((p) => coordOf(p, axis));
  const cMin = Math.min(...coords);
  const cMax = Math.max(...coords);
  const slotCount = slotMin.length;
  const { first, last } = candidateSlotRange(cMin, cMax, slotCount, SLOT_SIZE_MM);

  for (let i = first; i <= last; i++) {
    const { lo: slotLo, hi: slotHi } = slotRange(i, slotCount, SLOT_SIZE_MM, extent);
    const clipLo = Math.max(cMin, slotLo);
    const clipHi = Math.min(cMax, slotHi);
    if (clipLo > clipHi) continue;

    const clipped = clipConvexPolygonToAxisRange(hull, axis, clipLo, clipHi);
    if (clipped.length === 0) continue; // 理論上不應發生（見凸包連續性），防禦性略過。
    const values = clipped.map((p) => valueOf(p, axis));
    updateSlot(slotMin, slotMax, i, Math.min(...values), Math.max(...values));
  }
}

function contributeSegment(slotMin: number[], slotMax: number[], axis: Axis, extent: number, seg: Segment): void {
  if (seg.kind === 'line') contributeLine(slotMin, slotMax, axis, extent, seg);
  else if (seg.kind === 'arc') contributeArc(slotMin, slotMax, axis, extent, seg);
  else contributeBezier(slotMin, slotMax, axis, extent, seg);
}

/**
 * K > 4096 時把細槽（0.5mm）整數合併成粗槽——合併只取更寬鬆的 min/max（單調保守），
 * 不得直接以新的槽寬重切非巢狀邊界（spec F1）：粗槽 g 恰為細槽
 * `[g*groupSize, (g+1)*groupSize)` 的聯集，min/max 天然滿足「粗槽 ⊇ 任一構成細槽」。
 *
 * export 供測試直接鑑別（F3 review fix）：這個函式只吃已經算好的細槽 `fineMin`/`fineMax`
 * 陣列，不吃原始幾何（`Segment[]`）——簽章本身就結構性排除了「非巢狀重切」的替代實作
 * （重切需要原始 segments 才能在新槽寬下重新掃描，這裡拿不到）。直接對這個函式做單元測試
 * （`tests/profile.test.ts` 的 `mergeIntoSlotLimit` 專項 describe block）比只在
 * `computeProfileEnvelope` 端到端比較「加一個 spike 前後」更有鑑別力：後者兩種實作
 * （正確的巢狀聚合 vs. 錯誤的非巢狀重切）在特定案例上可能剛好算出同樣的結果。
 */
export function mergeIntoSlotLimit(
  fineMin: number[],
  fineMax: number[],
  fineSlotSize: number,
): { slotMin: number[]; slotMax: number[]; slotWidth: number } {
  const fineCount = fineMin.length;
  const groupSize = Math.ceil(fineCount / MAX_SLOTS_PER_AXIS);
  const coarseCount = Math.ceil(fineCount / groupSize);
  const coarseMin = new Array<number>(coarseCount).fill(Infinity);
  const coarseMax = new Array<number>(coarseCount).fill(-Infinity);

  for (let i = 0; i < fineCount; i++) {
    const g = Math.floor(i / groupSize);
    if (fineMin[i]! < coarseMin[g]!) coarseMin[g] = fineMin[i]!;
    if (fineMax[i]! > coarseMax[g]!) coarseMax[g] = fineMax[i]!;
  }

  return { slotMin: coarseMin, slotMax: coarseMax, slotWidth: fineSlotSize * groupSize };
}

function computeAxisSlots(segments: Segment[], axis: Axis, extent: number): { slotMin: number[]; slotMax: number[]; slotWidth: number } {
  const fineCount = Math.max(1, Math.ceil(extent / SLOT_SIZE_MM));
  const slotMin = new Array<number>(fineCount).fill(Infinity);
  const slotMax = new Array<number>(fineCount).fill(-Infinity);

  for (const seg of segments) {
    contributeSegment(slotMin, slotMax, axis, extent, seg);
  }

  if (fineCount <= MAX_SLOTS_PER_AXIS) {
    return { slotMin, slotMax, slotWidth: SLOT_SIZE_MM };
  }
  return mergeIntoSlotLimit(slotMin, slotMax, SLOT_SIZE_MM);
}

function translateSegment(seg: Segment, dx: number, dy: number): Segment {
  if (seg.kind === 'line') {
    return { kind: 'line', x1: seg.x1 + dx, y1: seg.y1 + dy, x2: seg.x2 + dx, y2: seg.y2 + dy };
  }
  if (seg.kind === 'arc') {
    return { ...seg, cx: seg.cx + dx, cy: seg.cy + dy };
  }
  return {
    kind: 'bezier',
    x1: seg.x1 + dx,
    y1: seg.y1 + dy,
    c1x: seg.c1x + dx,
    c1y: seg.c1y + dy,
    c2x: seg.c2x + dx,
    c2y: seg.c2y + dy,
    x2: seg.x2 + dx,
    y2: seg.y2 + dy,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 輪廓包絡（export 供測試鑑別，spec F1）
// ─────────────────────────────────────────────────────────────────────────

export interface ProfileEnvelope {
  /** x 分槽的實際槽寬（mm）——K≤4096 時＝0.5，否則為合併後的粗槽寬。 */
  slotWidthX: number;
  /** y 分槽的實際槽寬（mm）——語意同上，兩軸各自獨立判斷是否需要合併。 */
  slotWidthY: number;
  /** 沿 x 分槽：`top[i]`＝該槽 minY（局部座標，件 bounds.minX/minY 已平移到 0）。 */
  top: number[];
  /** 沿 x 分槽：`bottom[i]`＝該槽 maxY。空槽＝`Infinity`/`-Infinity`（spec 保證不會發生）。 */
  bottom: number[];
  /** 沿 y 分槽：`left[i]`＝該槽 minX。 */
  left: number[];
  /** 沿 y 分槽：`right[i]`＝該槽 maxX。 */
  right: number[];
}

/**
 * 四向 1D 輪廓包絡（spec F1／名詞段）：局部化到 `[0,W]×[0,H]` 後，沿 x 分槽記
 * `top(x)=minY`／`bottom(x)=maxY`，沿 y 分槽記 `left(y)=minX`／`right(y)=maxX`。
 * 純函式，export 供測試直接鑑別（不必每次都繞經 `computeProfileStrides` 的 gap 公式）。
 */
export function computeProfileEnvelope(segments: Segment[]): ProfileEnvelope {
  const bounds = segmentsBounds(segments);
  const W = Math.max(0, bounds.maxX - bounds.minX);
  const H = Math.max(0, bounds.maxY - bounds.minY);
  const localized = segments.map((s) => translateSegment(s, -bounds.minX, -bounds.minY));

  const xPass = computeAxisSlots(localized, 'x', W);
  const yPass = computeAxisSlots(localized, 'y', H);

  return {
    slotWidthX: xPass.slotWidth,
    slotWidthY: yPass.slotWidth,
    top: xPass.slotMin,
    bottom: xPass.slotMax,
    left: yPass.slotMin,
    right: yPass.slotMax,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// gap-aware minStride（spec 名詞段／F1）
// ─────────────────────────────────────────────────────────────────────────

/**
 * gap-aware 軸向最小位移：`max over 槽對(i,j)、dxMin(i,j)<gap [far[i]−near[j]+√(gap²−dxMin²)]`
 * （spec 名詞段）。`far`／`near` 對 strideY 分別是 bottom／top，對 strideX 分別是 right／left
 * ——同一份公式，呼叫端傳對陣列即可（見 `computeProfileStrides`）。
 *
 * `dxMin` 用槽對邊界最近距的保守下界（`max(0,(|i−j|−1)×slotWidth)`）——低估 Δx 使 √ 校正項
 * 高估，stride 高估＝保守（spec F1）。鄰域搜尋半徑 `reach` 依「`dxMin≥gap` 即不參與」的
 * 事實 clamp 到 `ceil(gap/slotWidth)+1`，並進一步 clamp 到實際槽數（plan-review M：大 gap
 * 不做無意義迭代）。
 *
 * export 供測試直接鑑別（本檔測試新增的 `computeMinStride` 根因直測，見下方 F2 fix 說明）。
 *
 * **F2 review fix**：件完全無材料（如 `computeProfileStrides([], gap)`）時，所有槽的
 * far／near 值皆為 ±Infinity，內層迴圈找不到任何一組「兩者皆有限」的槽對，`stride` 停在
 * 迴圈外的初始值 `0`——違反 spec 名詞段「恆有 `gap ≤ strideY ≤ H+gap`」不變式（`0 < gap`
 * 時即破例）。回傳前夾到至少 `gap`：對空幾何而言 `extent=0`，矩形上界退化為 `0+gap=gap`，
 * 與這個 clamp 的下界剛好重合（語意＝零尺寸件的矩形退化，不是另立特例，見
 * `tests/profile.test.ts` 空陣列測試）。
 *
 * 這個 clamp 對任何有材料的正常案例都是 no-op：`updateSlot` 保證同一槽的 min／max 恆同時
 * 被賦值（見檔頭「槽邊界雙邊歸屬」說明），所以只要有一個槽有材料，該槽的 `i=j` 同槽項
 * （`far[i]-near[i]+gap`，`far[i]≥near[i]` 恆成立因兩者皆由同一批 segment 貢獻的
 * min/max）本身就 `≥gap`——迴圈本來就會算出 `≥gap` 的候選值，這個 clamp 不會覆蓋掉任何
 * 正確算出的較大值。
 */
export function computeMinStride(far: number[], near: number[], gap: number, slotWidth: number): number {
  const n = far.length;
  const reach = Math.min(n, Math.ceil(gap / slotWidth) + 1);
  let stride = 0;

  for (let i = 0; i < n; i++) {
    const farValue = far[i]!;
    if (farValue === -Infinity) continue;
    const jLo = Math.max(0, i - reach);
    const jHi = Math.min(n - 1, i + reach);
    for (let j = jLo; j <= jHi; j++) {
      const nearValue = near[j]!;
      if (nearValue === Infinity) continue;
      const dxMin = Math.max(0, (Math.abs(i - j) - 1) * slotWidth);
      if (dxMin >= gap) continue;
      const candidate = farValue - nearValue + Math.sqrt(gap * gap - dxMin * dxMin);
      if (candidate > stride) stride = candidate;
    }
  }

  return Math.max(gap, stride);
}

// ─────────────────────────────────────────────────────────────────────────
// ProfileStrides opaque class（spec v1.4 §F2b／驗收 8）
// ─────────────────────────────────────────────────────────────────────────

/**
 * F3 單向擇優（`core/imposition.ts` Task 2）挑選單一軸 stride 時，承載「只留哪一軸」的
 * 選項給 `computeProfileStrides`——兩軸都要時省略此參數即可。
 */
export type ProfileStridesAxis = 'x' | 'y';

/**
 * `ImpositionInput.shrunk` 的型別（spec v1.4 §F2b 終版·v1.5 收 F1 review）：opaque class，
 * **唯一合法產地是本模組 export 的 `computeProfileStrides` 函式**（內部委託本類別的
 * `compute` 靜態方法——該方法本身是 class 的成員，是唯一能呼叫 `private constructor` 的
 * 地方；`compute` 的參數是幾何 `segments`＋`gap`＋可選單軸選項，不是任意數字）。
 *
 * - `private constructor` ＋ `#brand`（真正的 JS 私有欄位，不是 TS-only `private`）——
 *   手工物件字面量因缺少 `#brand` 在編譯期就不能賦值給 `ProfileStrides`（spec 驗收 8
 *   type-level①）。
 * - `{...instance, gap: 4}` 這類 spread 覆寫也不能賦值給 `ProfileStrides`（型別驗收②，
 *   v1.4·M2 收口的關鍵修正——舊版「branded plain object」的 brand 只是一般欄位，spread
 *   會原樣複製，讓覆寫後的偽造物件仍通過型別檢查）：`#brand` 是真正的私有欄位，不是一般
 *   可列舉屬性，spread 不會複製它，TS 對 spread 結果的型別推導同樣反映這個事實。
 * - `compute` 一律 `Object.freeze` 回傳的 instance——`Object.isFrozen` 可直接斷言
 *   （spec 驗收 8：getter 沒有 setter 本來就會讓「賦值會拋錯」這種 mutate 探測「假通過」
 *   ——不管有沒有 freeze 都會拋，不能證明真的凍結了，需要獨立斷言）。
 * - `strideX`/`strideY` 各自獨立可為 `undefined`（F2b 缺省語意：由呼叫端／F3 單向
 *   擇優透過 `onlyAxis` 決定要不要帶入某一軸；`gap` 恆為必填數字，是「這個 stride 是用
 *   哪個 gap 算的」這件事的機械驗證錨，見 spec F2b「gap 一致性」——那層 domain 驗證屬於
 *   `core/imposition.ts` 的職責，本類別本身不驗證數值合法性，只保證身份與不可變）。
 *
 * **F1 review fix（v1.5，review 指出）**：舊版 `static create(gap, strideX, strideY)` 是
 * *公開*數值工廠——`ProfileStrides.create(4, 236.2, 194.825)` 可以合法組出「宣告
 * `gap=4`、但 `194.825` 其實是用 `gap=3` 算出來的 stride」這種不同步 instance，即使帶
 * `#brand`＋`freeze` 也不需要 spread/any/JS 手法就能組出，重開 spec v1.4 五輪 review
 * 才封住的撞刀路徑（`shrunk.gap !== input.gap` 的 domain 檢查驗證的是「宣告的 gap」，
 * 從沒能驗證「這個 stride 數字真的是從這個 gap 算出來的」——公開數值工廠讓這個事實
 * 從型別層事實退化回口頭約定）。修法：拿掉公開數值工廠，只留一個吃幾何＋gap 的公開入口
 * （`computeProfileStrides`）；單軸缺省需求改用該入口的 `onlyAxis` 選項承載，由本模組
 * 內部（`compute` 方法本身就在 class body 內，能呼叫 private constructor）建 instance
 * ——gap 與算出的 stride 恆綁在同一次呼叫內，外部不可能再組出兩者不同步的實例。
 */
export class ProfileStrides {
  readonly #brand = 'ProfileStrides' as const;

  private constructor(
    private readonly _gap: number,
    private readonly _strideX: number | undefined,
    private readonly _strideY: number | undefined,
  ) {}

  get gap(): number {
    return this._gap;
  }

  get strideX(): number | undefined {
    return this._strideX;
  }

  get strideY(): number | undefined {
    return this._strideY;
  }

  /**
   * 唯一合法產地（連同頂層 `computeProfileStrides`——後者只是轉呼叫本方法，兩者是同一件
   * 事的兩個名字，保留頂層函式純粹是延續本模組「純函式、export 供測試鑑別」的既有慣例）：
   * 接收已過濾的製造幾何（`Segment[]`）＋`gap`，內部算出 envelope／minStride 後才建
   * instance。`onlyAxis` 承載 F3 單向擇優的單軸缺省需求（省略＝兩軸皆算，即
   * `computeProfileStrides` 的預設行為；`'x'`／`'y'`＝只留該軸，另一軸明確 `undefined`）
   * ——不論哪種呼叫方式，`gap` 與被保留的 stride 值恆來自同一次計算鏈，外部無法傳入
   * 「宣告的 gap 與算出 stride 的 gap 不同步」的組合（F1 review fix 收斂的漏洞）。
   *
   * 刻意不寫成 `return Object.freeze(new ProfileStrides(...))`：`Object.freeze<T>` 的型別簽章
   * 回傳 `Readonly<T>`，這是個「映射型別」（mapped type over keyof T），對含私有欄位的
   * class 會失去原本的具名 class 身份（TS 视 `Readonly<ProfileStrides>` 與 `ProfileStrides`
   * 不相容——實測會拋 TS2739）。改為先持有具名 class 型別的參照、呼叫 `Object.freeze`
   * 純粹取其「原地凍結」的 side effect（回傳值本身丟棄不用），再回傳原本那個具名參照——
   * 同一個物件，型別仍是乾淨的 `ProfileStrides`。
   */
  static compute(segments: Segment[], gap: number, onlyAxis?: ProfileStridesAxis): ProfileStrides {
    const envelope = computeProfileEnvelope(segments);
    const strideY = computeMinStride(envelope.bottom, envelope.top, gap, envelope.slotWidthX);
    const strideX = computeMinStride(envelope.right, envelope.left, gap, envelope.slotWidthY);

    const instance = new ProfileStrides(gap, onlyAxis === 'y' ? undefined : strideX, onlyAxis === 'x' ? undefined : strideY);
    Object.freeze(instance);
    return instance;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 計算入口（單一 export 函式：過濾後 segments＋gap → ProfileStrides，spec F1／v1.5 收 F1）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 單件製造幾何（已過濾的 `Segment[]`，見 `manufacturingPaths`）＋gap → `ProfileStrides`
 * （spec F1）。**本模組唯一的公開計算入口**（v1.5 收 F1 review：移除了舊版
 * `ProfileStrides.create(gap, strideX, strideY)` 這個接受任意數字的公開靜態工廠——它讓
 * 外部能合法組出「宣告的 gap 與算出 stride 的 gap 不同步」的 instance，見 `ProfileStrides`
 * class 文件字串的完整說明）。
 *
 * `onlyAxis` 承載 F3 單向擇優（`core/imposition.ts` Task 2）的單軸缺省需求：省略＝兩軸皆算
 * （預設行為，兩者恆為 finite 數字）；傳 `'x'`／`'y'`＝只留該軸的計算值，另一軸明確
 * `undefined`（F2b 缺省語意——該向使用矩形 stride）。不論哪種呼叫方式，gap 與被保留的
 * stride 值恆來自同一次 `computeProfileEnvelope`／`computeMinStride` 計算鏈。
 */
export function computeProfileStrides(segments: Segment[], gap: number, onlyAxis?: ProfileStridesAxis): ProfileStrides {
  return ProfileStrides.compute(segments, gap, onlyAxis);
}
