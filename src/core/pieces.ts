/**
 * pieces 完整性驗證（spec §3.3）——天地盒等多片盒型輸出的結構檢查。
 *
 * 只在 `result.pieces` 有值時生效（單片盒型如 RTE 不受約束）。這是內部/測試用的結構驗證
 * helper（回傳純資料型的 LocalizedText）——供天地盒 BoxModule 的 pieces-identity 不變式與
 * 具名槽位對帳測試共用。雙語字面在此與動態參數一起產生，UI 只依當前語言選取欄位；本核心
 * 模組不依賴 i18n runtime，也不讓 UI 反向解析中文訊息。
 * 純 TS 模組，不 import React、i18n 或任何 UI。
 */

import type { Bounds } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, LocalizedText } from '@/core/types';

// 浮點比較容差——這裡比較的兩側恆為同一組座標數字的不同推導路徑（如 piece.bounds 欄位 vs
// 由其成員 segments/texts 重新算出的 bounds），理論上應完全相等，容差只吸收浮點運算噪音，
// 不是像 RTE 不變式那種吸收生產公差的 0.01mm 級容差。
const EPS = 1e-6;

type CheckResult = { ok: true } | { ok: false; message: LocalizedText };

function invalid(zh: string, en: string): CheckResult {
  return { ok: false, message: { zh, en } };
}

/** 多個 Bounds 的聯集包絡；空陣列回傳 {0,0,0,0}（與 geometry.ts 的 segmentsBounds 同慣例）。 */
function unionBounds(list: Bounds[]): Bounds {
  if (list.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  return {
    minX: Math.min(...list.map((b) => b.minX)),
    maxX: Math.max(...list.map((b) => b.maxX)),
    minY: Math.min(...list.map((b) => b.minY)),
    maxY: Math.max(...list.map((b) => b.maxY)),
  };
}

/** outer 是否完整涵蓋 inner（含 EPS 容差）。 */
function boundsCovers(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.minX >= outer.minX - EPS &&
    inner.maxX <= outer.maxX + EPS &&
    inner.minY >= outer.minY - EPS &&
    inner.maxY <= outer.maxY + EPS
  );
}

/** a 與 b 四個欄位是否逐一相等（含 EPS 容差）。 */
function boundsEqual(a: Bounds, b: Bounds): boolean {
  return (
    Math.abs(a.minX - b.minX) <= EPS &&
    Math.abs(a.maxX - b.maxX) <= EPS &&
    Math.abs(a.minY - b.minY) <= EPS &&
    Math.abs(a.maxY - b.maxY) <= EPS
  );
}

/** a 與 b 是否有實際面積重疊（含 EPS 容差——恰好相鄰／共邊不算重疊）。 */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return overlapX > EPS && overlapY > EPS;
}

/** 片 id 是否全部唯一。 */
function checkUniqueIds(pieces: DielinePiece[]): CheckResult {
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (seen.has(piece.id)) {
      return invalid(
        `duplicate-piece-id: 片 id「${piece.id}」重複出現`,
        `duplicate-piece-id: piece id “${piece.id}” appears more than once`,
      );
    }
    seen.add(piece.id);
  }
  return { ok: true };
}

/** 每片至少要有一個 path 或 text 成員，不可為空殼片。 */
function checkNonEmpty(pieces: DielinePiece[]): CheckResult {
  for (const piece of pieces) {
    if (piece.pathIds.length === 0 && piece.textIds.length === 0) {
      return invalid(
        `empty-piece: 片「${piece.id}」沒有任何 path/text 成員`,
        `empty-piece: piece “${piece.id}” has no path/text members`,
      );
    }
  }
  return { ok: true };
}

/**
 * 某一類 id（path 或 text）在所有片之間的歸屬完整性：引用必須存在於 `allIds`
 * （否則 unknown-*-id）、每個 id 恰好屬於一片（否則 double-assigned-*）、
 * `allIds` 裡每個 id 都要被至少一片認領（否則 unassigned-*）。
 * path 與 text 走同一套邏輯（spec §3.3：兩者的歸屬規則完全對稱），用 `pick` 取出各片
 * 對應的 id 陣列、`kind` 只決定 message 用哪個關鍵詞前綴。
 */
function checkAssignment(
  pieces: DielinePiece[],
  allIds: string[],
  pick: (piece: DielinePiece) => string[],
  kind: 'path' | 'text',
): CheckResult {
  const allIdSet = new Set(allIds);
  const assignedTo = new Map<string, string>(); // id → 目前認領它的 piece.id

  for (const piece of pieces) {
    for (const id of pick(piece)) {
      if (!allIdSet.has(id)) {
        return invalid(
          `unknown-${kind}-id: 片「${piece.id}」引用了不存在的 ${kind} id「${id}」`,
          `unknown-${kind}-id: piece “${piece.id}” references nonexistent ${kind} id “${id}”`,
        );
      }
      const owner = assignedTo.get(id);
      if (owner !== undefined && owner !== piece.id) {
        return invalid(
          `double-assigned-${kind}: ${kind} id「${id}」同時被「${owner}」與「${piece.id}」兩片認領`,
          `double-assigned-${kind}: ${kind} id “${id}” is assigned to both “${owner}” and “${piece.id}”`,
        );
      }
      assignedTo.set(id, piece.id);
    }
  }

  for (const id of allIds) {
    if (!assignedTo.has(id)) {
      return invalid(
        `unassigned-${kind}: ${kind} id「${id}」未被任何片認領`,
        `unassigned-${kind}: ${kind} id “${id}” is not assigned to any piece`,
      );
    }
  }

  return { ok: true };
}

/** 片內成員（其 pathIds 對應的 segments ＋ textIds 對應的座標點）的實際 bounds 聯集。 */
function pieceMemberBounds(piece: DielinePiece, result: GenerateResult): Bounds {
  const pathIdSet = new Set(piece.pathIds);
  const textIdSet = new Set(piece.textIds);

  const segments = result.paths.filter((p) => pathIdSet.has(p.id)).flatMap((p) => p.segments);
  const textPoints: Bounds[] = result.texts
    .filter((t) => textIdSet.has(t.id))
    .map((t) => ({ minX: t.x, maxX: t.x, minY: t.y, maxY: t.y }));

  const segBoundsList = segments.length > 0 ? [segmentsBounds(segments)] : [];
  return unionBounds([...segBoundsList, ...textPoints]);
}

/** 每片宣告的 bounds 必須涵蓋自己成員的實際範圍（允許比實際範圍寬鬆，但不能漏）。 */
function checkPieceBoundsCoverMembers(pieces: DielinePiece[], result: GenerateResult): CheckResult {
  for (const piece of pieces) {
    const memberBounds = pieceMemberBounds(piece, result);
    if (!boundsCovers(piece.bounds, memberBounds)) {
      return invalid(
        `piece-bounds-mismatch: 片「${piece.id}」的 bounds 未涵蓋其成員的實際範圍`,
        `piece-bounds-mismatch: bounds for piece “${piece.id}” do not cover the actual extent of its members`,
      );
    }
  }
  return { ok: true };
}

/** 各片 bounds 兩兩之間不得有實際面積重疊（恰好相鄰、共用邊界不算）。 */
function checkNoOverlap(pieces: DielinePiece[]): CheckResult {
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i]!;
      const b = pieces[j]!;
      if (boundsOverlap(a.bounds, b.bounds)) {
        return invalid(
          `overlapping-pieces: 片「${a.id}」與「${b.id}」的 bounds 重疊`,
          `overlapping-pieces: bounds for pieces “${a.id}” and “${b.id}” overlap`,
        );
      }
    }
  }
  return { ok: true };
}

/** 總 bounds 必須等於全片 bounds 的聯集包絡（多了或少了都算不一致）。 */
function checkResultBoundsMatchesHull(pieces: DielinePiece[], resultBounds: Bounds): CheckResult {
  const hull = unionBounds(pieces.map((p) => p.bounds));
  if (!boundsEqual(hull, resultBounds)) {
    return invalid(
      'result-bounds-mismatch: GenerateResult.bounds 與全片 bounds 聯集包絡不一致',
      'result-bounds-mismatch: GenerateResult.bounds does not match the union hull of all piece bounds',
    );
  }
  return { ok: true };
}

/**
 * 總 bounds 必須等於「實際幾何」的包絡（spec §3.3 三向等式的第三邊：GenerateResult.bounds
 * ＝全片 hull＝全幾何 hull；前一檢查已驗 result.bounds＝全片 hull，此比對閉合等式鏈）。
 * 沒有這一比對，邊界片把 bounds 向外墊（外側無鄰片、不觸發 overlapping-pieces）、
 * result.bounds 跟著墊時，宣告層各檢查全過但宣告已與實際幾何脫節（Task 1 review 實證重現）。
 *
 * 幾何包絡口徑照 Slice 1 既有語意（reverse-tuck-end.ts 的 bounds-cover 不變式）：
 * segmentsBounds 對全部 paths 的 segments 計算，texts 不參與——文字是標註不是幾何，
 * 且此層拿不到字型度量，錨點只是退化的代理值。
 */
function checkResultBoundsMatchesGeometry(result: GenerateResult): CheckResult {
  const geometryHull = segmentsBounds(result.paths.flatMap((p) => p.segments));
  if (!boundsEqual(geometryHull, result.bounds)) {
    return invalid(
      'geometry-hull-mismatch: GenerateResult.bounds 與全幾何包絡不一致（宣告的 bounds 跟實際幾何脫節）',
      'geometry-hull-mismatch: GenerateResult.bounds does not match the full geometry hull; declared bounds are detached from the actual geometry',
    );
  }
  return { ok: true };
}

/**
 * pieces 完整性驗證（spec §3.3 全部規則）：
 * id 唯一、每片非空、path/text 歸屬聯集＝全集且兩兩不交、引用的 id 必須存在、
 * 各片 bounds 涵蓋自己的成員且兩兩不重疊、GenerateResult.bounds＝全片 bounds 聯集包絡
 * ＝全幾何包絡（三向等式，前兩邊分別由 result-bounds-mismatch／geometry-hull-mismatch 防守）。
 *
 * `result.pieces` 為 `undefined` 時視為單片盒型（如 RTE），直接視為合法，不做任何檢查
 * （RTE 的 bounds 含 ±20mm 畫布邊距、刻意大於幾何包絡——單片盒型不受三向等式約束）。
 */
export function validatePieces(result: GenerateResult): CheckResult {
  const { pieces } = result;
  if (pieces === undefined) {
    return { ok: true };
  }

  const uniqueIds = checkUniqueIds(pieces);
  if (!uniqueIds.ok) return uniqueIds;

  const nonEmpty = checkNonEmpty(pieces);
  if (!nonEmpty.ok) return nonEmpty;

  const pathIds = result.paths.map((p) => p.id);
  const pathAssignment = checkAssignment(pieces, pathIds, (p) => p.pathIds, 'path');
  if (!pathAssignment.ok) return pathAssignment;

  const textIds = result.texts.map((t) => t.id);
  const textAssignment = checkAssignment(pieces, textIds, (p) => p.textIds, 'text');
  if (!textAssignment.ok) return textAssignment;

  const boundsCover = checkPieceBoundsCoverMembers(pieces, result);
  if (!boundsCover.ok) return boundsCover;

  const noOverlap = checkNoOverlap(pieces);
  if (!noOverlap.ok) return noOverlap;

  const resultBoundsMatch = checkResultBoundsMatchesHull(pieces, result.bounds);
  if (!resultBoundsMatch.ok) return resultBoundsMatch;

  const geometryHullMatch = checkResultBoundsMatchesGeometry(result);
  if (!geometryHullMatch.ok) return geometryHullMatch;

  return { ok: true };
}

/**
 * 把 result 縮到只含 `piece` 的 paths/texts＋該片 bounds（pathIds/textIds 集合匹配，不是猜
 * index）。`toSvgDocument` 不消費 `GenerateResult.pieces` 欄位（只讀 paths/texts/bounds，
 * 見 export/svg.ts），縮完的物件省略 pieces 完全合法，餵給既有的 `toSvgDocument` 就能重用
 * 它內部按線型分 4 個命名 `<g>` 圖層的序列化邏輯，不需要另外複製一份匯出邏輯。
 */
export function scopeResultToPiece(result: GenerateResult, piece: DielinePiece): GenerateResult {
  const pathIds = new Set(piece.pathIds);
  const textIds = new Set(piece.textIds);
  return {
    paths: result.paths.filter((p) => pathIds.has(p.id)),
    texts: result.texts.filter((t) => textIds.has(t.id)),
    bounds: piece.bounds,
  };
}
