/**
 * polygon-boolean.ts — 測試專用多邊形布林運算 helper（凹面板凸拆分驗證共用基座）。
 *
 * 用 Sutherland–Hodgman 多邊形裁剪實作（不是離散化近似）：S-H 裁剪只要求「clip 是凸多邊形」，
 * subject 可以是任意簡單多邊形（含凹），裁出的交集面積是精確值（浮點捨入誤差量級 ~1e-10，
 * 跟座標尺度或形狀無關）。這裡預期的輸入形狀：`triangleInPolygon` 的三角形、
 * `pairwiseIntersectionArea`／`symmetricDifferenceArea` 的 fragment，都是凸拆分後的凸多邊形；
 * `outline`／原多邊形可以是凹的。測試專用，不進 src/。
 *
 * 使用 Sutherland–Hodgman 精確裁剪，誤差不依賴取樣解析度——即使非整數座標或大尺寸
 * outline，誤差量級仍遠低於 `AREA_TOLERANCE_MM2`。
 */

import type { Pt } from '@/fold/types';

/** 面積比對容差（mm²）——固定容差值，所有比較都用這個常數，不要各自硬編獨立數字。 */
export const AREA_TOLERANCE_MM2 = 0.05;

function shoelaceArea(poly: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** 判斷點 `p` 是否在 clip 有向邊 `a→b` 的「內側」半平面——`ccw` 決定內側是左手邊還是右手邊。 */
function isInsideDirectedEdge(p: Pt, a: Pt, b: Pt, ccw: boolean): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return ccw ? cross >= -1e-9 : cross <= 1e-9;
}

/** 求 subject 邊 `p1→p2` 與 clip 邊所在直線（無限延伸）的交點——S-H 標準作法。 */
function lineIntersection(p1: Pt, p2: Pt, a: Pt, b: Pt): Pt {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = b.x - a.x;
  const d2y = b.y - a.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-15) return p2; // subject 邊與 clip 邊平行——同側判斷已排除這個分支會被呼叫到
  const t = ((a.x - p1.x) * d2y - (a.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Sutherland–Hodgman 多邊形裁剪——`clip` 必須是凸多邊形（任一 winding 方向皆可，函式自動判斷），
 * `subject` 可以是任意簡單多邊形（含凹）。回傳 `subject ∩ clip` 的頂點序列（可能為空陣列，代表
 * 不相交）。若交集是多個不相連的區域，回傳的單一頂點序列會用零寬度的「橋接」邊把它們串起來——
 * 這樣的 polygon 用 shoelace 算出的面積仍然精確（橋接邊往返抵消，不貢獻淨面積；U 形凹
 * outline 等產生多重不相連區域的情況同樣成立）。
 */
function sutherlandHodgmanClip(subject: readonly Pt[], clip: readonly Pt[]): Pt[] {
  if (subject.length === 0 || clip.length < 3) return [];
  const ccw = shoelaceArea(clip) >= 0;
  let output: Pt[] = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]!;
      const prev = input[(j - 1 + input.length) % input.length]!;
      const curIn = isInsideDirectedEdge(cur, a, b, ccw);
      const prevIn = isInsideDirectedEdge(prev, a, b, ccw);
      if (curIn) {
        if (!prevIn) output.push(lineIntersection(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIntersection(prev, cur, a, b));
      }
    }
  }
  return output;
}

/** `subject ∩ clip` 的面積（`clip` 需為凸多邊形；`subject` 可凹）。 */
function convexClipIntersectionArea(subject: readonly Pt[], clip: readonly Pt[]): number {
  return Math.abs(shoelaceArea(sutherlandHodgmanClip(subject, clip)));
}

/**
 * 一組凸多邊形（fragment）的聯集面積，用 inclusion–exclusion 精確計算——`extraClip` 若給定
 * （可凹，如原多邊形 `a`），改算 `extraClip ∩ union(polys)` 的面積：每個子集交集（保證凸，
 * 因為 operand 全部是凸多邊形）本身可以拿來當 S-H 的 clip（S-H 只要求 clip 凸，subject 可凹），
 * 所以最後再裁一次 `extraClip` 即可。子集數 2^n，fragment 數量小（測試/單一 panel 拆分場景）時
 * 可負擔；這是精確公式，disjoint fragment 時高階項自動歸零，等價於單純面積相減。
 */
function unionAreaViaInclusionExclusion(polys: readonly Pt[][], extraClip?: readonly Pt[]): number {
  const n = polys.length;
  let total = 0;
  for (let mask = 1; mask < (1 << n); mask++) {
    let inter: Pt[] | undefined;
    let bits = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      bits++;
      inter = inter === undefined ? [...polys[i]!] : sutherlandHodgmanClip(inter, polys[i]!);
      if (inter.length === 0) break;
    }
    if (inter === undefined || inter.length === 0) continue;
    const area = extraClip !== undefined ? convexClipIntersectionArea(extraClip, inter) : Math.abs(shoelaceArea(inter));
    total += bits % 2 === 1 ? area : -area;
  }
  return total;
}

/**
 * 原多邊形 `a` 與 fragment 聯集 `b` 的對稱差面積（`area(a) + area(union(b)) − 2·area(a∩union(b))`，
 * 三項都用精確裁剪算出）——凹面板凸拆分後，用這個驗證「所有 fragment 拼回去＝原多邊形」，不只是
 * 比對面積總和（面積總和相同不代表幾何位置對得上，見測試反例）。`union(b)`／`a∩union(b)` 都用
 * inclusion–exclusion 精確處理，即使 fragment 之間有重疊（例如反例刻意構造的「缺洞＋重疊補洞」
 * 案例）也不會失真。
 */
export function symmetricDifferenceArea(a: Pt[], b: Pt[][]): number {
  const areaA = Math.abs(shoelaceArea(a));
  const unionArea = unionAreaViaInclusionExclusion(b);
  const interArea = unionAreaViaInclusionExclusion(b, a);
  return areaA + unionArea - 2 * interArea;
}

/**
 * 一組多邊形兩兩（i<j）交集面積總和——驗證凸拆分後的 fragment 彼此不重疊時應 ≈0。每一對都用
 * 精確裁剪（兩者皆凸時，clip 方向不影響結果）。
 */
export function pairwiseIntersectionArea(polys: Pt[][]): number {
  if (polys.length < 2) return 0;
  let area = 0;
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      area += convexClipIntersectionArea(polys[i]!, polys[j]!);
    }
  }
  return area;
}

/**
 * 三角形是否完全落在 `outline` 內——用「三角形面積 ≈ 三角形∩outline 面積」判定（容差
 * `AREA_TOLERANCE_MM2`），而不是只驗三頂點是否在內：三頂點都在內、但邊穿出一個凹陷的情形，
 * 只驗頂點會誤判為「在內」，這裡因為比對的是整塊面積會正確抓到。用 S-H 直接裁剪
 * `outline`（subject，可凹）against `tri`（clip，凸）算出精確交集面積，沒有離散化誤差。
 *
 * 退化（零面積）三角形一律拋錯——上游三角化不應該產生零面積三角形，靜默回傳任何布林值
 * 都會遮蔽這個訊號。
 */
export function triangleInPolygon(tri: [Pt, Pt, Pt], outline: Pt[]): boolean {
  const triArea = Math.abs(shoelaceArea(tri));
  if (triArea < 1e-9) {
    throw new Error(`triangleInPolygon：退化三角形（面積 ${triArea} < 1e-9）——上游三角化不應產生零面積三角形，這是訊號不是可忽略的邊界情況`);
  }
  const interArea = convexClipIntersectionArea(outline, tri);
  return Math.abs(triArea - interArea) <= AREA_TOLERANCE_MM2;
}
