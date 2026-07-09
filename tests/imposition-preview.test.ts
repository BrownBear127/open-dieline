import { describe, expect, it } from 'vitest';
import { instanceTransforms, previewPaths } from '@/ui/impositionPreview';
import { fitCount, MAX_PREVIEW_INSTANCES } from '@/core/imposition';
import type { Bounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult, LineType } from '@/core/types';

// ── instanceTransforms 變換代數驗證用的最小 helper（僅測試內部使用，不進生產碼）───────────
//
// jsdom 不支援 SVG matrix 運算，要驗證「cellX/cellY/cellW/cellH 這幾個數字」跟「transform
// 字串實際的幾何效果」是同一件事（而不是兩邊各自看起來合理、偶然對上的數字），唯一辦法是
// 自己重新套用這個變換。只需支援 instanceTransforms 實際會產生的兩種原子變換
// （translate／rotate(90)），不是通用 SVG transform parser。

type Pt = { x: number; y: number };

function applyTransform(transform: string, p: Pt): Pt {
  const tokens = [...transform.matchAll(/(translate|rotate)\(([^)]+)\)/g)].map((m) => ({
    kind: m[1] as 'translate' | 'rotate',
    args: m[2]!.trim().split(/\s+/).map(Number),
  }));
  // SVG transform-list 對「點」的套用順序是由右到左：字串裡最右邊的變換最先作用在原始點上。
  return tokens.reduceRight((pt, t) => {
    if (t.kind === 'translate') {
      const [dx, dy] = t.args as [number, number];
      return { x: pt.x + dx, y: pt.y + dy };
    }
    // rotate(90)：本模組只產生 90°，SVG 順時針 (x,y)→(−y,x)（brief 明定的旋轉方向）。
    return { x: -pt.y, y: pt.x };
  }, p);
}

/** 把 mb 四個角點套用 transform 後的實際包絡矩形——驗證是否真的等於 instance 回報的
 *  cellX/cellY/cellW/cellH，而不是兩邊獨立、偶然吻合的數字。 */
function transformedBounds(transform: string, mb: Bounds): { minX: number; maxX: number; minY: number; maxY: number } {
  const corners = [
    { x: mb.minX, y: mb.minY },
    { x: mb.maxX, y: mb.minY },
    { x: mb.minX, y: mb.maxY },
    { x: mb.maxX, y: mb.maxY },
  ].map((p) => applyTransform(transform, p));
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

describe('instanceTransforms — 數量', () => {
  it('cols×rows 在 cap 內：數量恰為 cols×rows', () => {
    const mb: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 20 };
    expect(instanceTransforms(0, 3, 4, mb, 5, 2)).toHaveLength(12);
  });

  it('cols×rows 超過 MAX_PREVIEW_INSTANCES（30×30=900）→ 截斷至上限', () => {
    const mb: Bounds = { minX: 0, maxX: 5, minY: 0, maxY: 5 };
    expect(instanceTransforms(0, 30, 30, mb, 0, 1)).toHaveLength(MAX_PREVIEW_INSTANCES);
  });

  it('極大 logical count（cols=rows=332,226，review High 引用的合法輸入上界，乘積約 1103 億）→ 立即回傳 500 個、耗時 < 1 秒（cap 惰性建構回歸測試）', () => {
    const mb: Bounds = { minX: 0, maxX: 0.01, minY: 0, maxY: 0.01 };
    const start = Date.now();
    const result = instanceTransforms(0, 332_226, 332_226, mb, 0, 3);
    const elapsed = Date.now() - start;
    expect(result).toHaveLength(MAX_PREVIEW_INSTANCES);
    expect(elapsed).toBeLessThan(1000);
  });

  it('cols 或 rows 為 0 → 空陣列（不是丟例外）', () => {
    const mb: Bounds = { minX: 0, maxX: 5, minY: 0, maxY: 5 };
    expect(instanceTransforms(0, 0, 4, mb, 0, 1)).toHaveLength(0);
    expect(instanceTransforms(90, 4, 0, mb, 0, 1)).toHaveLength(0);
  });
});

describe('instanceTransforms — 0° 佔位＋變換代數驗證', () => {
  it('cell 矩形＝gripper+cell*(w+gap) 起、寬高＝mb 原始寬高；變換字串套用後的幾何與 cellX/Y/W/H 一致', () => {
    const mb: Bounds = { minX: 5, maxX: 35, minY: -7, maxY: 13 }; // w=30, h=20，非零 min
    const gripper = 10;
    const gap = 4;
    const instances = instanceTransforms(0, 2, 2, mb, gripper, gap);
    expect(instances).toHaveLength(4);

    // c=1,r=1（非原點的一格，避免湊巧全零通過）：flatten 順序＝r*cols+c＝1*2+1＝3
    const inst = instances[3]!;
    expect(inst.cellW).toBe(30);
    expect(inst.cellH).toBe(20);
    expect(inst.cellX).toBe(44); // 10 + 1*(30+4)
    expect(inst.cellY).toBe(34); // 10 + 1*(20+4)

    const bounds = transformedBounds(inst.transform, mb);
    expect(bounds).toEqual({ minX: inst.cellX, maxX: inst.cellX + inst.cellW, minY: inst.cellY, maxY: inst.cellY + inst.cellH });
  });
});

describe('instanceTransforms — 90° 佔位驗證（非零 min mb，spec 驗收條件 7）', () => {
  const mb: Bounds = { minX: 5, minY: -7, maxX: 35, maxY: 13 }; // w=30 寬、h=20 高
  const gripper = 10;
  const gap = 4;
  // 90° 旋轉後佔位＝h×w＝20×30。用 fitCount（T2）反推「剛好塞滿」的可用區，讓這個測試
  // 同時驗證「T2 fitCount 認為塞得下的格數」與「T3 cell 位移實際佔據的矩形」用的是同一套
  // footprint 公式——不是各自巧合對得上，是兩個模組對同一個契約的獨立實作。
  const cols = 3;
  const rows = 2;
  const usableW = cols * 20 + (cols - 1) * gap; // 3*20+2*4=68，恰好塞滿
  const usableH = rows * 30 + (rows - 1) * gap; // 2*30+1*4=64，恰好塞滿

  it('前提檢查：fitCount 反推的 cols/rows 與本測試手算一致', () => {
    expect(fitCount(usableW, 20, gap)).toBe(cols);
    expect(fitCount(usableH, 30, gap)).toBe(rows);
  });

  it('全部 instance 的 cell 矩形落在可用區內，邊界 instance 恰好貼齊（非寬鬆通過）', () => {
    const instances = instanceTransforms(90, cols, rows, mb, gripper, gap);
    expect(instances).toHaveLength(cols * rows);

    for (const inst of instances) {
      expect(inst.cellW).toBe(20); // 旋轉後寬＝mb 原始高
      expect(inst.cellH).toBe(30); // 旋轉後高＝mb 原始寬
      expect(inst.cellX).toBeGreaterThanOrEqual(gripper);
      expect(inst.cellY).toBeGreaterThanOrEqual(gripper);
      expect(inst.cellX + inst.cellW).toBeLessThanOrEqual(gripper + usableW);
      expect(inst.cellY + inst.cellH).toBeLessThanOrEqual(gripper + usableH);
    }

    // 最後一格（c=cols-1, r=rows-1）恰好貼齊可用區右下角。
    const last = instances[instances.length - 1]!;
    expect(last.cellX + last.cellW).toBe(gripper + usableW);
    expect(last.cellY + last.cellH).toBe(gripper + usableH);
  });

  it('cell step＝旋轉後寬高＋gap（相鄰 instance 的 cellX 差）', () => {
    const instances = instanceTransforms(90, cols, rows, mb, gripper, gap);
    const first = instances[0]!; // c=0,r=0
    const second = instances[1]!; // c=1,r=0（row-major）
    expect(second.cellX - first.cellX).toBe(20 + gap);
  });

  it('變換字串套用後的實際幾何包絡＝cellX/Y/W/H（逐一驗證每個 instance，非單點抽驗）', () => {
    const instances = instanceTransforms(90, cols, rows, mb, gripper, gap);
    for (const inst of instances) {
      const bounds = transformedBounds(inst.transform, mb);
      expect(bounds).toEqual({
        minX: inst.cellX,
        maxX: inst.cellX + inst.cellW,
        minY: inst.cellY,
        maxY: inst.cellY + inst.cellH,
      });
    }
  });
});

// ── previewPaths ─────────────────────────────────────────────────────────

const ALL_LINE_TYPES: LineType[] = ['cut', 'crease', 'halfcut', 'bleed', 'annotation', 'dimension'];

function makePath(id: string, type: LineType): DielinePath {
  return { id, type, segments: [{ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }] };
}

function makeMixedResult(): GenerateResult {
  return {
    paths: ALL_LINE_TYPES.map((t) => makePath(`p-${t}`, t)),
    texts: [],
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
  };
}

describe('previewPaths', () => {
  it('六線型混合 → 只回 cut/crease/halfcut（piece=null，全版）', () => {
    const paths = previewPaths(makeMixedResult(), null);
    expect(paths.map((p) => p.type).sort()).toEqual(['crease', 'cut', 'halfcut']);
  });

  it('piece 過濾走 pathIds：只保留該片 pathIds 內、且線型仍是三線型之一的 paths', () => {
    const result: GenerateResult = {
      paths: [makePath('a-cut', 'cut'), makePath('a-dim', 'dimension'), makePath('b-cut', 'cut'), makePath('b-crease', 'crease')],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const pieceA: DielinePiece = { id: 'a', label: { zh: 'A' }, pathIds: ['a-cut', 'a-dim'], textIds: [], bounds: result.bounds };
    // a-dim 屬於片 A 但線型不在預覽三線型內、b-* 線型合格但不屬於片 A：兩種排除理由都要驗到。
    expect(previewPaths(result, pieceA).map((p) => p.id)).toEqual(['a-cut']);
  });
});
