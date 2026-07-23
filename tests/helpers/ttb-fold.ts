import { triangularTube } from '@/boxes/triangular-tube';
import type { ResolvedParams } from '@/core/types';
import type { Vec3 } from '@/fold/pose3d';

/**
 * ttb（三角盒）3D fold 測試共用幾何 helper。
 *
 * `tests/fold/ttb-model.test.ts`／`tests/fold/ttb-closure.test.ts`／
 * `tests/fold/ttb-reconcile.test.ts` 共用同一批 in-plane frame／Sutherland–Hodgman clip／
 * slot 抽取 helper，避免三個測試檔各自維護一份可能漂移的複本。
 *
 * 測試專用（不進 `src/`）：這裡的「面板世界頂點建 2D frame」「slot 從 2D 實際抽取」等手法
 * 都是驗收概念，非 fold model 本身的執行期不變量。
 */

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function normalizeVec(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export interface Plane2D { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3 }

/** 盒身面板世界頂點建 in-plane frame（canonical polygon 首邊沿局部+x、末點沿局部+y）。 */
export function facePlaneOf(geo: Map<string, Vec3[]>, faceId: string): Plane2D {
  const face = geo.get(faceId)!;
  const origin = face[0]!;
  const u = normalizeVec(sub(face[1]!, face[0]!)); // 沿面板寬度（管軸方向）
  const v = normalizeVec(sub(face[face.length - 1]!, face[0]!)); // 沿面板深度
  const normal = normalizeVec(cross3(u, v));
  return { origin, u, v, normal };
}

/** faceAPlane＝facePlaneOf(geo,'faceA') 的具名別名——faceA 是 root、foldAngle=0，世界座標恆等於原 2D layout，slot/tab oracle 慣用此座標框。 */
export function faceAPlane(geo: Map<string, Vec3[]>): Plane2D {
  return facePlaneOf(geo, 'faceA');
}

export function distToPlane(point: Vec3, plane: Plane2D): number {
  return Math.abs(dot(sub(point, plane.origin), plane.normal));
}

export function project2D(point: Vec3, plane: Plane2D): { x: number; y: number } {
  const rel = sub(point, plane.origin);
  return { x: dot(rel, plane.u), y: dot(rel, plane.v) };
}

export function shoelaceArea(poly: { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function clipEdgeInside(p2: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return (b.x - a.x) * (p2.y - a.y) - (b.y - a.y) * (p2.x - a.x) >= 0;
}

function lineIntersection(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = b.x - a.x;
  const d2y = b.y - a.y;
  const denom = d1x * d2y - d1y * d2x;
  const t = ((a.x - p1.x) * d2y - (a.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/** Sutherland–Hodgman：clip 必須是凸多邊形，subject 允許凹多邊形。 */
export function clipPolygon(
  subject: { x: number; y: number }[],
  clip: { x: number; y: number }[],
): { x: number; y: number }[] {
  let output = subject;
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) break;
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const current = input[j]!;
      const prev = input[(j - 1 + input.length) % input.length]!;
      const currentInside = clipEdgeInside(current, a, b);
      const prevInside = clipEdgeInside(prev, a, b);
      if (currentInside) {
        if (!prevInside) output.push(lineIntersection(prev, current, a, b));
        output.push(current);
      } else if (prevInside) {
        output.push(lineIntersection(prev, current, a, b));
      }
    }
  }
  return output;
}

/** panel 世界投影（Sutherland–Hodgman 對 faceA 矩形裁切）與 faceA 自身面積之比——真多邊形交集，非邊界框近似。 */
export function overlapRatioWithFiniteFaceA(geo: Map<string, Vec3[]>, panelId: string): number {
  const plane = faceAPlane(geo);
  const faceAPoly = geo.get('faceA')!.map((v) => project2D(v, plane));
  const subjectPoly = geo.get(panelId)!.map((v) => project2D(v, plane));
  const clipped = clipPolygon(subjectPoly, faceAPoly);
  const overlapArea = Math.abs(shoelaceArea(clipped));
  const faceAArea = Math.abs(shoelaceArea(faceAPoly));
  return overlapArea / faceAArea;
}

/**
 * 面板自由邊兩端世界座標——panelize 後 canonical polygon 的盒身外側邊序：
 *   faceA 自由邊＝local top 邊（y=0）→ index0=(x=0 端)、index1=(x=L 端)
 *   faceC 自由邊＝local bottom 邊（y=yCD）→ index3=(x=0 端)、index2=(x=L 端)
 */
export function freeEdgeEndpoints(geo: Map<string, Vec3[]>, id: 'faceA' | 'faceC'): [Vec3, Vec3] {
  const world = geo.get(id)!;
  return id === 'faceA' ? [world[0]!, world[1]!] : [world[3]!, world[2]!];
}

export interface SlotSegment2D { x1: number; x2: number; y: number }

/**
 * 從 2D `GenerateResult` 的 `abSlot` cut path 抽出插槽水平段（非用公式重算——
 * slot 必須從 2D 實際抽取，不可依賴重算公式）。`abSlot` 這條複合路徑裡有 3 條水平線段（左右橋接＝
 * y=edgeA、插槽本身＝y=edgeA−0.799），用「y≠edgeA」篩出唯一那一條，不假設/複製
 * `SLOT_OFFSET` 這個私有常數（`src/boxes/triangular-tube.ts` 未 export）。
 */
export function slotSegmentFrom2D(params: ResolvedParams): SlotSegment2D {
  const result = triangularTube.generate(params);
  const edgeA = params.edgeA as number;
  const abSlotPath = result.paths.find((path) => path.tags?.includes('abSlot'));
  if (!abSlotPath) throw new Error('未找到 abSlot cut path');
  const slotLine = abSlotPath.segments.find(
    (seg) => seg.kind === 'line' && seg.y1 === seg.y2 && Math.abs(seg.y1 - edgeA) > 1e-6,
  );
  if (!slotLine || slotLine.kind !== 'line') throw new Error('abSlot path 內找不到插槽水平段');
  return { x1: slotLine.x1, x2: slotLine.x2, y: slotLine.y1 };
}

export function slotWidthOf(params: ResolvedParams): number {
  const slot = slotSegmentFrom2D(params);
  return Math.abs(slot.x2 - slot.x1);
}

export interface SignedDistances { rootSide: number; tipSide: number }

/**
 * tab 根部/尖端在 faceA 平面內、沿 slot 線法向（=faceA 深度軸）的 signed distance。
 * 單一凹 `zoneDTab` 的 root 為投影深度最大邊、apex 為投影深度最小點。
 */
export function tabSignedDistancesToSlotLine(geo: Map<string, Vec3[]>, slot: SlotSegment2D): SignedDistances {
  const plane = faceAPlane(geo);
  const slotDepth = dot(sub({ x: slot.x1, y: slot.y, z: 0 }, plane.origin), plane.v);
  const tabDepths = geo.get('zoneDTab')!.map((point) => project2D(point, plane).y);
  const rootDepth = Math.max(...tabDepths);
  const tipDepth = Math.min(...tabDepths);
  return { rootSide: rootDepth - slotDepth, tipSide: tipDepth - slotDepth };
}

export interface CrossSection { overlapWidth: number; tabFullWidth: number }

/**
 * tab 在 slot 深度處的實際切面寬度——沿單一 `zoneDTab` 世界投影多邊形逐邊掃描，
 * 取所有與「深度=slotDepth」水平線相交的邊的交點寬度
 * 座標 max−min（真幾何切片，不是套用預期寬度公式重算一次）。
 */
export function tabSlotCrossSection(geo: Map<string, Vec3[]>, slot: SlotSegment2D): CrossSection {
  const plane = faceAPlane(geo);
  const slotDepth = dot(sub({ x: slot.x1, y: slot.y, z: 0 }, plane.origin), plane.v);
  const tab2D = geo.get('zoneDTab')!.map((v) => project2D(v, plane));
  const crossingWidths: number[] = [];
  for (let i = 0; i < tab2D.length; i++) {
    const a = tab2D[i]!;
    const b = tab2D[(i + 1) % tab2D.length]!;
    if (a.y === b.y) continue; // 與目標深度平行的邊（root/notch 底）不提供交叉資訊
    if ((a.y - slotDepth) * (b.y - slotDepth) > 0) continue; // 兩端同側，未跨過目標深度
    const t = (slotDepth - a.y) / (b.y - a.y);
    crossingWidths.push(a.x + t * (b.x - a.x));
  }
  const overlapWidthRaw = crossingWidths.length >= 2 ? Math.max(...crossingWidths) - Math.min(...crossingWidths) : 0;
  const slotWidth = Math.abs(slot.x2 - slot.x1);
  const tabFullWidth = Math.max(...tab2D.map(({ x }) => x)) - Math.min(...tab2D.map(({ x }) => x));
  return { overlapWidth: Math.min(overlapWidthRaw, slotWidth), tabFullWidth };
}

/**
 * 三角盒合法參數組合——逐字取自 `tests/boxes/param-sweep.test.ts`「三角盒（triangularTube）
 * 參數邊界掃描」＞「合法參數組合：全 invariants 通過」describe block 的 7 組 overrides，
 * 確保這裡驗證的是已知合法的參數邊界。
 */
export const TTB_LEGAL_COMBOS: Array<Record<string, number>> = [
  {},
  { tubeLength: 115 },
  { edgeA: 78.5, tubeLength: 150 },
  { edgeA: 120, tubeLength: 300 },
  { edgeA: 20, tubeLength: 60 },
  { tubeLength: 200, tabWidth: 100, tabDepth: 20 },
  { edgeA: 40, tabWidth: 55, tabDepth: 30 },
];

/** 面板頂點到「有限」目標面板（非無限平面）的最大距離——沿面內 (s,t) clamp 到 [0,uSpan]x[0,vSpan] 後量 3D 距離。 */
export function maxVertexDistToFinitePanel(geo: Map<string, Vec3[]>, panelId: string, faceId: string): number {
  const plane = facePlaneOf(geo, faceId);
  const face = geo.get(faceId)!;
  const uSpan = dist(face[1]!, face[0]!);
  const vSpan = dist(face[face.length - 1]!, face[0]!);
  let maxD = 0;
  for (const point of geo.get(panelId)!) {
    const rel = sub(point, plane.origin);
    const s = dot(rel, plane.u);
    const t = dot(rel, plane.v);
    const sc = Math.min(Math.max(s, 0), uSpan);
    const tc = Math.min(Math.max(t, 0), vSpan);
    const clamped: Vec3 = {
      x: plane.origin.x + sc * plane.u.x + tc * plane.v.x,
      y: plane.origin.y + sc * plane.u.y + tc * plane.v.y,
      z: plane.origin.z + sc * plane.u.z + tc * plane.v.z,
    };
    maxD = Math.max(maxD, dist(point, clamped));
  }
  return maxD;
}

/** 覆蓋率驗收：wing 頂點正交投影到目標面平面成多邊形 Π，area(Π∩有限面板)/area(Π)（Sutherland–Hodgman）。 */
export function wingCoverage(geo: Map<string, Vec3[]>, panelId: string, faceId: string): number {
  const plane = facePlaneOf(geo, faceId);
  const face = geo.get(faceId)!;
  const uSpan = dist(face[1]!, face[0]!);
  const vSpan = dist(face[face.length - 1]!, face[0]!);
  const proj = geo.get(panelId)!.map((point) => project2D(point, plane));
  const projArea = Math.abs(shoelaceArea(proj));
  const faceRect = [{ x: 0, y: 0 }, { x: uSpan, y: 0 }, { x: uSpan, y: vSpan }, { x: 0, y: vSpan }];
  const clippedArea = Math.abs(shoelaceArea(clipPolygon(proj, faceRect)));
  return projArea > 0 ? clippedArea / projArea : 0;
}

/**
 * 端封垂直管軸驗收：endMain 摺角軸（H–Hb）與管軸（世界 x 軸）夾角偏離 90°的量——結構性應恆為 0
 * （H/Hb 是 endMain 自己 hinge 的軸上兩點，只受 faceB 累積變換影響，而 faceB hinge 軸
 * 沿全域 x，故 H–Hb 世界向量 x 分量恆為 0）。canonical polygon 中，Start 側
 * H/Hb 位於 index 2/3，End 側位於 index 0/4。
 */
export function endMainAxisAngle(geo: Map<string, Vec3[]>, mainId: string): number {
  const world = geo.get(mainId)!;
  const H = mainId.includes('Start') ? world[2]! : world[0]!;
  const Hb = mainId.includes('Start') ? world[3]! : world[4]!;
  const axis = sub(Hb, H);
  const axisLen = Math.hypot(axis.x, axis.y, axis.z);
  const cosAngle = axis.x / axisLen; // dot(axis, (1,0,0)) / |axis|
  const angleFromTubeAxis = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
  return Math.abs(angleFromTubeAxis - Math.PI / 2);
}

export const WINGS = ['endStartWingTop', 'endStartWingBottom', 'endEndWingTop', 'endEndWingBottom'] as const;
export const targetOf = (w: string): 'faceA' | 'faceC' => (w.endsWith('Top') ? 'faceA' : 'faceC');
