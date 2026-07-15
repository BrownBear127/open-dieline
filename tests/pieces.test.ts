import { describe, it, expect } from 'vitest';
import type { Bounds } from '@/core/geometry';
import type { DielinePath, DielineText, DielinePiece, GenerateResult } from '@/core/types';
import { validatePieces, scopeResultToPiece } from '@/core/pieces';
import { resolveParams } from '@/core/registry';
import { telescope } from '@/boxes/telescope';

// ── 測試專用工具：手工組最小的 DielinePath/DielineText/DielinePiece/GenerateResult ──
// （spec 要求「手工組的最小 GenerateResult」，不依賴任何真實盒型的 generate()）

function makePath(id: string, x1: number, y1: number, x2: number, y2: number): DielinePath {
  return { id, type: 'cut', segments: [{ kind: 'line', x1, y1, x2, y2 }] };
}

function makeText(id: string, x: number, y: number): DielineText {
  return { id, x, y, text: id };
}

function makePiece(id: string, pathIds: string[], textIds: string[], bounds: Bounds): DielinePiece {
  return { id, label: { zh: id, en: id }, pathIds, textIds, bounds };
}

/**
 * 合法的三片基準案例：lid／base／liner 三片，各自一條 path＋一個 text，x 方向彼此分隔
 * （無重疊、有間距），片 bounds 恰好等於成員的實際範圍，總 bounds 恰好等於三片 bounds 聯集。
 * 每個測試案例都從這裡複製一份再做單一項突變，確保每個案例只踩到一種 violation。
 */
function legalResult(): GenerateResult {
  const paths = [makePath('p-lid', 0, 0, 10, 10), makePath('p-base', 20, 0, 30, 10), makePath('p-liner', 40, 0, 50, 10)];
  const texts = [makeText('t-lid', 5, 5), makeText('t-base', 25, 5), makeText('t-liner', 45, 5)];
  const pieces: DielinePiece[] = [
    makePiece('lid', ['p-lid'], ['t-lid'], { minX: 0, maxX: 10, minY: 0, maxY: 10 }),
    makePiece('base', ['p-base'], ['t-base'], { minX: 20, maxX: 30, minY: 0, maxY: 10 }),
    makePiece('liner', ['p-liner'], ['t-liner'], { minX: 40, maxX: 50, minY: 0, maxY: 10 }),
  ];
  return { paths, texts, pieces, bounds: { minX: 0, maxX: 50, minY: 0, maxY: 10 } };
}

/** 斷言 validatePieces 判定不通過，且 message 含指定關鍵詞（各 violation 案例共用的斷言邏輯）。 */
function expectViolation(result: GenerateResult, keyword: string): void {
  const check = validatePieces(result);
  expect(check.ok, `應偵測到 ${keyword} violation`).toBe(false);
  if (!check.ok) {
    expect(check.message).toContain(keyword);
  }
}

describe('validatePieces', () => {
  it('pieces === undefined 時直接視為合法（單片盒型如 RTE 不受影響）', () => {
    const result: GenerateResult = {
      paths: [makePath('p1', 0, 0, 10, 10)],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    expect(result.pieces).toBeUndefined();
    expect(validatePieces(result)).toEqual({ ok: true });
  });

  it('合法三片案例（lid/base/liner，互不重疊、歸屬完整、bounds 一致）→ ok', () => {
    expect(validatePieces(legalResult())).toEqual({ ok: true });
  });

  it('片 id 重複 → duplicate-piece-id', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [base.pieces![0]!, { ...base.pieces![1]!, id: 'lid' }, base.pieces![2]!],
    };
    expectViolation(result, 'duplicate-piece-id');
  });

  it('片沒有任何 path/text 成員 → empty-piece', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [{ ...base.pieces![0]!, pathIds: [], textIds: [] }, base.pieces![1]!, base.pieces![2]!],
    };
    expectViolation(result, 'empty-piece');
  });

  it('存在未被任何片認領的 path → unassigned-path', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      paths: [...base.paths, makePath('p-orphan', 60, 0, 70, 10)],
    };
    expectViolation(result, 'unassigned-path');
  });

  // ── text 側鏡射案例（spec §3.3／Global Constraints 明定 path/text 歸屬規則對稱，
  // checkAssignment 對兩者走同一套邏輯——這三案例確保 text 側的分支真的被跑到，
  // 不是只靠 path 側測試「順便」覆蓋到同一段程式碼）──

  it('存在未被任何片認領的 text → unassigned-text', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      texts: [...base.texts, makeText('t-orphan', 65, 5)],
    };
    expectViolation(result, 'unassigned-text');
  });

  it('同一個 path id 被兩片同時認領 → double-assigned-path', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [
        { ...base.pieces![0]!, pathIds: [...base.pieces![0]!.pathIds, 'p-base'] },
        base.pieces![1]!,
        base.pieces![2]!,
      ],
    };
    expectViolation(result, 'double-assigned-path');
  });

  it('同一個 text id 被兩片同時認領 → double-assigned-text', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [
        { ...base.pieces![0]!, textIds: [...base.pieces![0]!.textIds, 't-base'] },
        base.pieces![1]!,
        base.pieces![2]!,
      ],
    };
    expectViolation(result, 'double-assigned-text');
  });

  it('片引用了不存在的 path id → unknown-path-id', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [
        { ...base.pieces![0]!, pathIds: [...base.pieces![0]!.pathIds, 'p-ghost'] },
        base.pieces![1]!,
        base.pieces![2]!,
      ],
    };
    expectViolation(result, 'unknown-path-id');
  });

  it('片引用了不存在的 text id → unknown-text-id', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [
        { ...base.pieces![0]!, textIds: [...base.pieces![0]!.textIds, 't-ghost'] },
        base.pieces![1]!,
        base.pieces![2]!,
      ],
    };
    expectViolation(result, 'unknown-text-id');
  });

  it('片 bounds 未涵蓋自己成員的實際範圍 → piece-bounds-mismatch', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      // lid 的 path 'p-lid' 實際延伸到 x=10，這裡把片 bounds 砍到 maxX=5，漏了成員的一半
      pieces: [{ ...base.pieces![0]!, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 10 } }, base.pieces![1]!, base.pieces![2]!],
    };
    expectViolation(result, 'piece-bounds-mismatch');
  });

  it('兩片 bounds 有實際面積重疊 → overlapping-pieces', () => {
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      // base 的 bounds 左緣由 20 拉到 5，跟 lid 的 [0,10] 在 x=[5,10] 範圍重疊；
      // base 自己的成員（p-base 座落 [20,30]）仍在拉寬後的 [5,30] 內，不會誤觸 piece-bounds-mismatch
      pieces: [base.pieces![0]!, { ...base.pieces![1]!, bounds: { minX: 5, maxX: 30, minY: 0, maxY: 10 } }, base.pieces![2]!],
    };
    expectViolation(result, 'overlapping-pieces');
  });

  it('總 bounds 不等於全片 bounds 聯集 → result-bounds-mismatch', () => {
    const base = legalResult();
    const result: GenerateResult = { ...base, bounds: { minX: 0, maxX: 999, minY: 0, maxY: 10 } };
    expectViolation(result, 'result-bounds-mismatch');
  });

  it('宣告層自洽但與實際幾何脫節（邊界片 bounds 外墊、result.bounds 跟著墊）→ geometry-hull-mismatch', () => {
    // Task 1 review 抓到的漏洞重現（Important finding）：只驗「result.bounds ＝ 全片 bounds
    // 聯集」抓不到「宣告跟實際幾何整體脫節」——最左片 lid 的 bounds 向左外墊 100（左側無鄰片，
    // 不觸發 overlapping-pieces；成員仍被涵蓋，不觸發 piece-bounds-mismatch），result.bounds
    // 跟著墊到同一位置（宣告層聯集一致，不觸發 result-bounds-mismatch）——宣告層檢查全過，
    // 但 GenerateResult.bounds 已不等於全幾何包絡（spec §3.3 三向等式的第三邊）。
    const base = legalResult();
    const result: GenerateResult = {
      ...base,
      pieces: [
        { ...base.pieces![0]!, bounds: { minX: -100, maxX: 10, minY: 0, maxY: 10 } },
        base.pieces![1]!,
        base.pieces![2]!,
      ],
      bounds: { minX: -100, maxX: 50, minY: 0, maxY: 10 },
    };
    expectViolation(result, 'geometry-hull-mismatch');
  });
});

describe('scopeResultToPiece（自 ExportBar 搬入·move-only）', () => {
  it('telescope base 片：輸出只含該片 pathIds/textIds，bounds 縮到該片', () => {
    const full = telescope.generate(resolveParams(telescope));
    const base = full.pieces!.find((p) => p.id === 'base')!;
    const scoped = scopeResultToPiece(full, base);
    expect(scoped.paths.every((p) => base.pathIds.includes(p.id))).toBe(true);
    expect(scoped.paths.length).toBeLessThan(full.paths.length);
  });
  it('lid 片與 base 片的 path 集合不重疊', () => {
    const full = telescope.generate(resolveParams(telescope));
    const [lid, base] = [full.pieces!.find((p) => p.id === 'lid')!, full.pieces!.find((p) => p.id === 'base')!];
    const lidIds = new Set(scopeResultToPiece(full, lid).paths.map((p) => p.id));
    const baseIds = scopeResultToPiece(full, base).paths.map((p) => p.id);
    expect(baseIds.some((id) => lidIds.has(id))).toBe(false);
  });
});
