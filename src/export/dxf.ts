/**
 * DXF R12 匯出——把 `core/types` 的 `GenerateResult` 序列化成 R12 ASCII DXF 文件字串（下載交付給
 * 刀模廠雷射/刀模切割機讀取；R12 是業界支援最廣的 legacy ASCII 版本，group code/值逐行、無二進位）。
 *
 * 貝茲離散復用 `core/geometry.ts` 的 `flattenBezier`（spec §6.2 的離散演算法只有一份，不重寫）。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm；角度單位在本檔內從弧度轉換為度
 * （DXF ARC 的 50/51 皆為十進位度數）。
 *
 * **座標系決策（v1）**：Segment 的 y 軸沿用 SVG 慣例（向下為正），DXF 標準座標系 y 軸向上——
 * v1 刻意不做 y 翻轉，讓畫布／SVG／DXF 三種輸出鏡像一致；單面刀模對鏡像不敏感，刀模廠的
 * 排版軟體通常會自行翻面。是否需要加翻轉選項，留待法蘭實際送檔流程驗證後再決定（T6 gate）。
 *
 * **圖層排除規則（生產檔裁決）**：dimension/annotation 線型與全部 `texts` 一律不輸出到 DXF——
 * 口徑與 `export/svg.ts` 的 `DIMENSION_LINE_TYPES`（`manufacturingBounds` 排除標註取幾何包絡
 * 用的同一份集合）一致，但本檔選擇不額外 import：`DXF_LAYER_BY_LINETYPE` 只映射 cut/crease/
 * halfcut 三型，任何不在這張表裡的線型（dimension/annotation，以及受 no-bleed 不變式保證不會
 * 實際出現的 bleed）在 `pathEntities` 就被防禦性跳過，效果等價、少一個跨檔 import。
 */

import type { Segment } from '@/core/geometry';
import { flattenBezier } from '@/core/geometry';
import type { DielinePath, GenerateResult, LineType } from '@/core/types';

type LineSeg = Extract<Segment, { kind: 'line' }>;
type ArcSeg = Extract<Segment, { kind: 'arc' }>;
type BezierSeg = Extract<Segment, { kind: 'bezier' }>;

// LineType → DXF 圖層名映射；同時是「哪些線型會輸出到 DXF」的判準（見上方檔頭圖層排除規則）。
export const DXF_LAYER_BY_LINETYPE: Readonly<Partial<Record<LineType, string>>> = {
  cut: 'CUT',
  crease: 'CREASE',
  halfcut: 'HALFCUT',
};

// LineType → AutoCAD Color Index（ACI）：對應 core/styles.ts LINE_STYLES 的視覺配色慣例
// （cut 黑/白＝7、crease 綠＝3、halfcut 黃＝2，見 spec §6.1／§6.2）。
const DXF_ACI_BY_LINETYPE: Readonly<Partial<Record<LineType, number>>> = {
  cut: 7,
  crease: 3,
  halfcut: 2,
};

const decimals = 4;

/**
 * toFixed(4) 後去尾零（DXF 慣例可接受變動位數的定點數；4 位小數在 mm 下＝0.1µm 級，遠超
 * 製造精度）；`-0` 收斂為 `0`（沿用 svg.ts／path.ts 的 fmt 慣例，見該二檔）。
 */
function fmt(v: number): string {
  const fixed = v.toFixed(decimals);
  const normalized = fixed === '-0.0000' ? '0.0000' : fixed;
  return normalized.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * R12 一手規格（AutoCAD Release 12 DXF Reference）：LINE 為 `10,20,30`／`11,21,31`、ARC 圓心
 * 為 `10,20,30`、VERTEX 為 `10,20,30`——這些 30 群組碼都沒有標 `-optional`，跟同文件裡其他
 * 明確標 `-optional N` 的欄位對照，代表恆輸出（見 task-1-report.md F1 查證）。本檔座標系是
 * 純平面（`core/geometry.ts` 的 `Segment` 無 Z 欄位），Z 恆為 0；用具名常數取代散落的字面
 * `'0'`，同時讓「這是刻意補的 Z，不是漏寫」的意圖可搜尋。
 */
const ZERO_Z = '0';

/** 弧度→度，並 normalize 到 [0,360)（DXF ARC 的 50/51 皆為十進位度數）。 */
function degFromRad(rad: number): number {
  const deg = (rad * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** 一組 group code/值，各佔一行（R12 ASCII 慣例；全檔統一用 \n，見檔尾 toDxfDocument）。 */
function gc(code: number, value: string | number): string {
  return `${code}\n${value}`;
}

function lineEntity(layer: string, s: LineSeg): string {
  return [
    gc(0, 'LINE'),
    gc(8, layer),
    gc(10, fmt(s.x1)),
    gc(20, fmt(s.y1)),
    gc(30, ZERO_Z),
    gc(11, fmt(s.x2)),
    gc(21, fmt(s.y2)),
    gc(31, ZERO_Z),
  ].join('\n');
}

function arcEntity(layer: string, s: ArcSeg): string {
  const startDeg = degFromRad(s.startAngle);
  const endDeg = degFromRad(s.endAngle);
  // DXF ARC 的 50/51 恆以「角度遞增方向」由 50 掃到 51 描述弧、不足 360 就跨圈補（WebSearch
  // 已交叉確認：ezdxf/dxfwrite 文件與業界討論一致認定 DXF ARC 恆逆時針，見 task report）。
  // core/geometry.ts 的 angleInArc 註解定義 Segment.ccw=false 正是「角度遞增方向」掃描，
  // 語意與 DXF 原生一致，直接輸出（50=start、51=end）；ccw=true 是「角度遞減方向」掃描，
  // 若原樣輸出 50=start/51=end，DXF 會用遞增方向描出角度上互補的另一段弧（例：90°→0°順時針
  // 掃的 90° 弧，若不交換會被讀成 90°→360° 的 270° 錯誤弧——即「刀模弧翻面」）。必須交換
  // 50=end、51=start，讓 DXF 的遞增掃描重現與原 Segment 完全相同的弧段。
  const [dxfStart, dxfEnd] = s.ccw ? [endDeg, startDeg] : [startDeg, endDeg];
  return [
    gc(0, 'ARC'),
    gc(8, layer),
    gc(10, fmt(s.cx)),
    gc(20, fmt(s.cy)),
    gc(30, ZERO_Z),
    gc(40, fmt(s.r)),
    gc(50, fmt(dxfStart)),
    gc(51, fmt(dxfEnd)),
  ].join('\n');
}

function vertexEntity(layer: string, x: number, y: number): string {
  return [gc(0, 'VERTEX'), gc(8, layer), gc(10, fmt(x)), gc(20, fmt(y)), gc(30, ZERO_Z)].join('\n');
}

/** bezier → POLYLINE：flattenBezier 離散（預設 chordTol=0.1／maxSegLen=5，即 spec 值）成折線頂點。 */
function polylineEntity(layer: string, s: BezierSeg): string {
  const flattened = flattenBezier(s);
  const first = flattened[0]!; // flattenBezier 恆回傳至少一段，見該函式遞迴的 base case
  const vertices = [vertexEntity(layer, first.x1, first.y1), ...flattened.map((seg) => vertexEntity(layer, seg.x2, seg.y2))];
  // 66（vertices-follow）之後、70（polyline flags）之前補 dummy elevation point 10/0 20/0
  // 30/0：R12 一手規格明列 POLYLINE 條目含 10,20,30（"10 和 20 恆為 0、30 才是真正的
  // elevation"），未標 -optional；本檔無 elevation 概念（純平面座標系），30 恆 0，見上方
  // ZERO_Z 與 task-1-report.md F1。
  const header = [gc(0, 'POLYLINE'), gc(8, layer), gc(66, 1), gc(10, ZERO_Z), gc(20, ZERO_Z), gc(30, ZERO_Z), gc(70, 0)].join('\n');
  return [header, ...vertices, gc(0, 'SEQEND')].join('\n');
}

function segmentEntity(layer: string, s: Segment): string {
  if (s.kind === 'line') return lineEntity(layer, s);
  if (s.kind === 'arc') return arcEntity(layer, s);
  return polylineEntity(layer, s);
}

/** 單一 DielinePath → 0 或多個實體字串；線型不在 DXF_LAYER_BY_LINETYPE 映射表裡就整條跳過。 */
function pathEntities(p: DielinePath): string[] {
  const layer = DXF_LAYER_BY_LINETYPE[p.type];
  if (!layer) return [];
  return p.segments.map((s) => segmentEntity(layer, s));
}

function layerEntry(lineType: LineType): string {
  const name = DXF_LAYER_BY_LINETYPE[lineType]!;
  const aci = DXF_ACI_BY_LINETYPE[lineType]!;
  return [gc(0, 'LAYER'), gc(2, name), gc(70, 0), gc(62, aci), gc(6, 'CONTINUOUS')].join('\n');
}

function headerSection(): string {
  return [gc(0, 'SECTION'), gc(2, 'HEADER'), gc(9, '$ACADVER'), gc(1, 'AC1009'), gc(0, 'ENDSEC')].join('\n');
}

function tablesSection(): string {
  // Object.keys 對字面量物件的字串鍵保留宣告序（cut/crease/halfcut）——LAYER table 條目序
  // 因此穩定等於 DXF_LAYER_BY_LINETYPE 的宣告序，不需要另外排序。
  const lineTypes = Object.keys(DXF_LAYER_BY_LINETYPE) as LineType[];
  const header = [gc(0, 'SECTION'), gc(2, 'TABLES'), gc(0, 'TABLE'), gc(2, 'LAYER'), gc(70, lineTypes.length)].join('\n');
  const entries = lineTypes.map(layerEntry);
  return [header, ...entries, gc(0, 'ENDTAB'), gc(0, 'ENDSEC')].join('\n');
}

function entitiesSection(result: GenerateResult): string {
  const body = result.paths.flatMap(pathEntities);
  return [gc(0, 'SECTION'), gc(2, 'ENTITIES'), ...body, gc(0, 'ENDSEC')].join('\n');
}

/**
 * `GenerateResult` → 完整 R12 ASCII DXF 文件字串。
 *
 * 只消費 `result.paths`——`texts` 依上方檔頭規則全數排除；`bounds`/`pieces` 是 UI／SVG 用的
 * 版面中繼資料，DXF 實體本身帶絕對座標，CAD/雷射切割軟體會自行 auto-fit，不需要另外宣告
 * extents（brief 的 HEADER 骨架也只要求 $ACADVER，未要求 $EXTMIN/$EXTMAX）。
 *
 * **已知限制（不修，記錄供未來參考——review F4）**：若某 arc Segment 的 `startAngle`／
 * `endAngle` 恰差 2π 整數倍（即完整圓），`degFromRad` 會把兩者 normalize 到同一角度，
 * `arcEntity` 因此輸出 50=0、51=0 的零掃掠 ARC（下游讀取器對此的解讀未定義，多半視為退化/
 * 不可見弧，不保證讀成完整圓）。目前這個輸入不可達：盒型幾何唯一的弧構造點
 * `PathBuilder.arcTo`（`core/path.ts`）在起訖點重合時直接 throw（見該檔「弦長為 0」錯誤），
 * 無法產生完整圓 Segment；獨立的 overlay 對照層（`docs/plans/2026-07-09-v1-slice3-overlay-dxf.md`）
 * 明確不進 `GenerateResult`、不參與匯出。若未來 `GenerateResult` 的來源改變、可能出現真正的
 * 完整圓 Segment，本函式應先偵測這個情形並改輸出 CIRCLE 實體，而非讓它靜默 collapse 成零
 * 掃掠 ARC。
 */
export function toDxfDocument(result: GenerateResult): string {
  return [headerSection(), tablesSection(), entitiesSection(result), gc(0, 'EOF')].join('\n');
}
