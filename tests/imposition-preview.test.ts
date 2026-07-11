import { describe, expect, it } from 'vitest';
import { directionInstances, sectionOffsets, previewPaths } from '@/ui/impositionPreview';
import type { PreviewInstance } from '@/ui/impositionPreview';
import { MAX_PREVIEW_INSTANCES } from '@/core/imposition';
import type { DirectionResult, WorkingSheet } from '@/core/imposition';
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

// `instanceTransforms` 已於 T3 controller 裁決刪除（唯一消費者是 T3 重寫的 DirectionCard，
// 改吃 `directionInstances`；見 task-3-brief interim 清單第 3 點）——以下把原本鎖住
// `buildGrid` 引擎 0°/90° 變換代數的測試改吃 `directionInstances`（傳入 `fillSplit:null` 的
// `DirectionResult`，此時 `directionInstances` 只跑主格點 `buildGrid` 這條路徑，行為與舊版
// `instanceTransforms(dir, cols, rows, mb, gripper, gap)` 逐字等價：`limit` 給 500
// ≥MAX_PREVIEW_INSTANCES，`normalizeBudget` 硬限後恰等於舊版寫死的 cap）。cap 截斷／
// cols·rows=0／極大數字惰性建構這幾個分支已由 `directionInstances` 自己的測試（budget
// 邊界、Global Constraints「主格點為 0」、huge cols/rows 惰性建構）覆蓋，這裡不重複。

/** 建構「無補排」的 `DirectionResult`——只用來讓 `directionInstances` 只走主格點
 *  `buildGrid` 路徑，count/totalCount/utilization 這裡不驗證，數字只需型別合法。
 *  spacingAxis/strideX/strideY/usedW/usedH（T2 新增五欄）同理不影響本檔任何斷言——
 *  `directionInstances` 只讀 cols/rows/fillSplit/bottomFill/rightFill，usedW/usedH 自己
 *  重算（見 impositionPreview.ts `directionInstances` docblock「DirectionResult 不帶這兩個
 *  欄位」段）；且這個 factory 本身無 piece 尺寸／gap 參數（兩個呼叫端各自傳入不同 mb/gap），
 *  無法推導真實數值，比照既有欄位精神給型別合法的中性值。 */
function noFillDirection(cols: number, rows: number): DirectionResult {
  const gridCount = cols * rows;
  return {
    cols,
    rows,
    gridCount,
    fillSplit: null,
    bottomFill: null,
    rightFill: null,
    count: gridCount,
    totalCount: gridCount,
    utilization: 0,
    spacingAxis: null,
    strideX: 0,
    strideY: 0,
    usedW: 0,
    usedH: 0,
  };
}

describe('directionInstances（fillSplit=null）— buildGrid 主格點代數驗證', () => {
  it('0°：cell 矩形＝gripper+cell*(w+gap) 起、寬高＝mb 原始寬高；變換字串套用後的幾何與 cellX/Y/W/H 一致', () => {
    const mb: Bounds = { minX: 5, maxX: 35, minY: -7, maxY: 13 }; // w=30, h=20，非零 min
    const gripper = 10;
    const gap = 4;
    const instances = directionInstances(0, noFillDirection(2, 2), mb, gripper, gap, 500);
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

  it('90°（非零 min mb，spec 驗收條件 7）：全部 instance 的 cell 矩形落在可用區內、邊界貼齊；cell step＝旋轉後寬高＋gap；變換代數逐一驗證', () => {
    const mb: Bounds = { minX: 5, minY: -7, maxX: 35, maxY: 13 }; // w=30 寬、h=20 高
    const gripper = 10;
    const gap = 4;
    // 90° 旋轉後佔位＝h×w＝20×30；usableW/usableH 恰好塞滿 cols=3,rows=2（手算，非反推）。
    const cols = 3;
    const rows = 2;
    const usableW = cols * 20 + (cols - 1) * gap; // 3*20+2*4=68
    const usableH = rows * 30 + (rows - 1) * gap; // 2*30+1*4=64

    const instances = directionInstances(90, noFillDirection(cols, rows), mb, gripper, gap, 500);
    expect(instances).toHaveLength(cols * rows);

    for (const inst of instances) {
      expect(inst.cellW).toBe(20); // 旋轉後寬＝mb 原始高
      expect(inst.cellH).toBe(30); // 旋轉後高＝mb 原始寬
      expect(inst.cellX).toBeGreaterThanOrEqual(gripper);
      expect(inst.cellY).toBeGreaterThanOrEqual(gripper);
      expect(inst.cellX + inst.cellW).toBeLessThanOrEqual(gripper + usableW);
      expect(inst.cellY + inst.cellH).toBeLessThanOrEqual(gripper + usableH);

      const bounds = transformedBounds(inst.transform, mb);
      expect(bounds).toEqual({ minX: inst.cellX, maxX: inst.cellX + inst.cellW, minY: inst.cellY, maxY: inst.cellY + inst.cellH });
    }

    // 最後一格（c=cols-1, r=rows-1）恰好貼齊可用區右下角；相鄰 instance 的 cellX 差＝cell step。
    const last = instances[instances.length - 1]!;
    expect(last.cellX + last.cellW).toBe(gripper + usableW);
    expect(last.cellY + last.cellH).toBe(gripper + usableH);
    expect(instances[1]!.cellX - instances[0]!.cellX).toBe(20 + gap); // c=1,r=0 − c=0,r=0（row-major）
  });
});

// ── directionInstances／sectionOffsets 測試用的小 helper（task-2 新增，僅測試內部使用）──

/** 斷言 instance 的 cell 矩形四個數字，避免每個測試案例重複四行 toBe。 */
function expectCell(inst: PreviewInstance, cellX: number, cellY: number, cellW: number, cellH: number): void {
  expect(inst.cellX).toBe(cellX);
  expect(inst.cellY).toBe(cellY);
  expect(inst.cellW).toBe(cellW);
  expect(inst.cellH).toBe(cellH);
}

// ── directionInstances — 補排件（task-2） ───────────────────────────────

describe('directionInstances — 主格點＋補排條帶排列（bottom-full／right-full 條帶原點公式）', () => {
  // w=10,h=6，非零 min（延續既有測試風格，避免只在零 min 下巧合成立）。
  const mb: Bounds = { minX: 1, maxX: 11, minY: 2, maxY: 8 };
  const gripper = 5;
  const gap = 2;
  // dir=0 → cellW=10=w、cellH=6=h。cols=2,rows=3 → usedW=2*10+1*2=22、usedH=3*6+2*2=22。
  // 底條帶原點＝(gripper,gripper+usedH+gap)=(5,29)；右條帶原點＝(gripper+usedW+gap,gripper)=(29,5)
  // ——brief RED 條款明定的公式，逐字硬編碼在下面斷言，不由被測函式導出（spec F8）。
  const bottomFullDirection: DirectionResult = {
    cols: 2,
    rows: 3,
    gridCount: 6,
    fillSplit: 'bottom-full',
    bottomFill: { cols: 2, rows: 1, count: 2 },
    rightFill: { cols: 1, rows: 2, count: 2 },
    count: 10,
    totalCount: 10,
    utilization: 0.5, // 本模組不讀 count/totalCount/utilization，數字只需型別合法
    spacingAxis: null, // 無 shrunk 輸入 → 矩形雙軸、零收益（spec：null＝無收縮或零收益）
    strideX: 12, // pieceForCols(cellW=10，見上方 dir=0 註解)+gap(2)＝矩形 stride（未收縮）
    strideY: 8, // pieceForRows(cellH=6)+gap(2)
    usedW: 22, // cellW+(cols-1)*strideX=10+1*12=22（沿用上方既有推導註解逐字核對）
    usedH: 22, // cellH+(rows-1)*strideY=6+2*8=22（沿用上方既有推導註解逐字核對）
  };
  // 同一組 cols/rows/mb/gripper/gap（usedW/usedH 因此相同）、只換 fillSplit 與兩條帶各自的
  // cols/rows——驗證「條帶原點公式與 fillSplit 是 bottom-full 還是 right-full 無關」（brief
  // RED：兩種分割的原點公式相同，差別只在哪條帶拿到全長延伸，那已經反映在 core 算好的
  // cols/rows 裡，這裡不需要另外分支）。
  const rightFullDirection: DirectionResult = {
    ...bottomFullDirection,
    fillSplit: 'right-full',
    bottomFill: { cols: 1, rows: 1, count: 1 },
    rightFill: { cols: 1, rows: 3, count: 3 },
  };

  it('bottom-full：底條帶原點 (5,29)、右條帶原點 (29,5)；件數＝主格點6＋底2＋右2＝10', () => {
    const instances = directionInstances(0, bottomFullDirection, mb, gripper, gap, 100);
    expect(instances).toHaveLength(10);
    expectCell(instances[6]!, 5, 29, 6, 10); // 底條帶 i=0
    expectCell(instances[7]!, 13, 29, 6, 10); // 底條帶 i=1（cellX 差＝cellW+gap=6+2=8）
    expectCell(instances[8]!, 29, 5, 6, 10); // 右條帶 i=0
    expectCell(instances[9]!, 29, 17, 6, 10); // 右條帶 i=1（cellY 差＝cellH+gap=10+2=12）
  });

  it('right-full：同一組 usedW/usedH 下，底／右條帶原點與 bottom-full 案例逐字相同', () => {
    const instances = directionInstances(0, rightFullDirection, mb, gripper, gap, 100);
    expect(instances).toHaveLength(6 + 1 + 3); // 主格點6＋底1＋右3
    expectCell(instances[6]!, 5, 29, 6, 10); // 底條帶原點——與 bottom-full 案例相同
    expectCell(instances[7]!, 29, 5, 6, 10); // 右條帶原點——與 bottom-full 案例相同
    expectCell(instances[8]!, 29, 17, 6, 10);
    expectCell(instances[9]!, 29, 29, 6, 10);
  });

  it('補排件變換字串套用後的實際幾何包絡＝cellX/Y/W/H（代數驗證，非僅信任回報數字）', () => {
    const instances = directionInstances(0, bottomFullDirection, mb, gripper, gap, 100);
    for (const inst of instances.slice(6)) {
      // 只驗補排件——主格點沿用既有 instanceTransforms 測試已覆蓋的同一套引擎。
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

describe('directionInstances — 補排件旋轉方向與主方向相反', () => {
  it('主 dir=0 時補排件帶 translate(h,0) rotate(90) 修正鏈', () => {
    const mb: Bounds = { minX: 1, maxX: 11, minY: 2, maxY: 8 }; // h=6
    const direction: DirectionResult = {
      cols: 2,
      rows: 3,
      gridCount: 6,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 2, rows: 1, count: 2 },
      rightFill: { cols: 1, rows: 2, count: 2 },
      count: 10,
      totalCount: 10,
      utilization: 0.5,
      spacingAxis: null, // 無 shrunk 輸入 → null
      strideX: 12, // pieceForCols(mb w=11-1=10)+gap(2，見下方呼叫)＝矩形 stride
      strideY: 8, // pieceForRows(mb h=8-2=6)+gap(2)
      usedW: 22, // 10+(2-1)*12=22（cols=2,rows=3 與 bottomFullDirection 案例同形）
      usedH: 22, // 6+(3-1)*8=22
    };
    const instances = directionInstances(0, direction, mb, 5, 2, 100);
    // 底條帶第一件：cellX=5,cellY=29；h=mb 原始高=6；localize=translate(-1 -2)。
    expect(instances[6]!.transform).toBe('translate(5 29) translate(6 0) rotate(90) translate(-1 -2)');
  });

  it('主 dir=90 時補排件為 0°（無 rotate token）', () => {
    const mb: Bounds = { minX: 0, maxX: 8, minY: 0, maxY: 4 }; // 零 min，localize 化簡為 translate(0 0)
    const gripper = 3;
    const gap = 1;
    // dir=90 → cellW=h=4,cellH=w=8。cols=2,rows=2 → usedW=2*4+1*1=9、usedH=2*8+1*1=17。
    // 底原點=(3,21)、右原點=(13,3)。
    const direction: DirectionResult = {
      cols: 2,
      rows: 2,
      gridCount: 4,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 1, rows: 1, count: 1 },
      rightFill: { cols: 1, rows: 1, count: 1 },
      count: 6,
      totalCount: 6,
      utilization: 0.5,
      spacingAxis: null, // 無 shrunk 輸入 → null
      strideX: 5, // pieceForCols(cellW=4)+gap(1)——90° 卡 cols 軸吃旋轉後寬 4
      strideY: 9, // pieceForRows(cellH=8)+gap(1)
      usedW: 9, // 沿用上方既有推導註解：2*4+1*1=9
      usedH: 17, // 沿用上方既有推導註解：2*8+1*1=17
    };
    const instances = directionInstances(90, direction, mb, gripper, gap, 100);
    expect(instances).toHaveLength(6);

    const bottomInst = instances[4]!;
    expect(bottomInst.transform).toBe('translate(3 21) translate(0 0)');
    expect(bottomInst.transform).not.toContain('rotate');
    expectCell(bottomInst, 3, 21, 8, 4);

    const rightInst = instances[5]!;
    expect(rightInst.transform).toBe('translate(13 3) translate(0 0)');
    expectCell(rightInst, 13, 3, 8, 4);
  });
});

describe('directionInstances — 截斷順序＋budget 恰截在主排/補排交界（主格點 row-major → 底條帶 → 右條帶）', () => {
  const mb: Bounds = { minX: 1, maxX: 11, minY: 2, maxY: 8 };
  const gripper = 5;
  const gap = 2;
  const direction: DirectionResult = {
    cols: 2,
    rows: 3,
    gridCount: 6, // 主格點 6 個
    fillSplit: 'bottom-full',
    bottomFill: { cols: 2, rows: 1, count: 2 }, // 底條帶 2 個
    rightFill: { cols: 1, rows: 2, count: 2 }, // 右條帶 2 個
    count: 10,
    totalCount: 10,
    utilization: 0.5,
    spacingAxis: null, // 無 shrunk 輸入 → null
    strideX: 12, // pieceForCols(mb w=10)+gap(2)——與 bottomFullDirection 案例同一組 mb/gap/cols/rows
    strideY: 8, // pieceForRows(mb h=6)+gap(2)
    usedW: 22, // 10+(2-1)*12=22
    usedH: 22, // 6+(3-1)*8=22
  };

  it.each([
    { budget: 6, expectedLength: 6, label: '恰截在「主排全部／補排全無」交界' },
    { budget: 7, expectedLength: 7, label: '主排全部＋底條帶第 1 個' },
    { budget: 8, expectedLength: 8, label: '恰截在「底條帶全部／右條帶全無」交界' },
    { budget: 9, expectedLength: 9, label: '底條帶全部＋右條帶第 1 個' },
    { budget: 10, expectedLength: 10, label: '恰截在「右條帶全部／預算仍有餘裕」交界' },
    { budget: 100, expectedLength: 10, label: '預算遠超結構總數：不會無中生有多畫' },
  ])('budget=$budget → $label（長度 $expectedLength）', ({ budget, expectedLength }) => {
    expect(directionInstances(0, direction, mb, gripper, gap, budget)).toHaveLength(expectedLength);
  });

  it('budget=6 時全部是主格點（cellW=10/cellH=6，不是補排件的 cellW=6/cellH=10）', () => {
    const instances = directionInstances(0, direction, mb, gripper, gap, 6);
    expect(instances.map((inst) => [inst.cellW, inst.cellH])).toEqual(Array(6).fill([10, 6]));
  });

  it('budget=7 時第 7 個（index 6）是底條帶第 1 個，原點 (5,29)', () => {
    const instances = directionInstances(0, direction, mb, gripper, gap, 7);
    expectCell(instances[6]!, 5, 29, 6, 10);
  });

  it('budget=9 時第 9 個（index 8）是右條帶第 1 個，原點 (29,5)', () => {
    const instances = directionInstances(0, direction, mb, gripper, gap, 9);
    expectCell(instances[8]!, 29, 5, 6, 10);
  });
});

describe('directionInstances — Global Constraints「主格點為 0 時不補排」', () => {
  it('gridCount=0（cols=0，fillSplit 因此為 null）→ 空陣列', () => {
    const mb: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 20 };
    const direction: DirectionResult = {
      cols: 0,
      rows: 4,
      gridCount: 0,
      fillSplit: null,
      bottomFill: null,
      rightFill: null,
      count: 0,
      totalCount: 0,
      utilization: 0,
      // 即使 cols=0，strideX 仍照矩形算（見 core computeGridAndFill：strideForCols 無條件回傳，
      // 不因 n=0 而省略；只有 usedW 才有 n=0→0 特判，見下方）。
      spacingAxis: null, // 無 shrunk 輸入 → null
      strideX: 12, // pieceForCols(mb w=10)+gap(2，見下方呼叫)
      strideY: 22, // pieceForRows(mb h=20)+gap(2)
      usedW: 0, // n=0→0（spec F2b 明定，cols=0）
      usedH: 86, // n≥1：20+(4-1)*22=86（rows=4，pieceForRows=20,strideY=22）
    };
    expect(directionInstances(0, direction, mb, 5, 2, 100)).toEqual([]);
  });
});

describe('directionInstances — budget 邊界（SOL review High 2：正規化並硬限 0…MAX_PREVIEW_INSTANCES）', () => {
  const mb: Bounds = { minX: 1, maxX: 11, minY: 2, maxY: 8 };
  const gripper = 5;
  const gap = 2;
  const direction: DirectionResult = {
    cols: 2,
    rows: 3,
    gridCount: 6,
    fillSplit: 'bottom-full',
    bottomFill: { cols: 2, rows: 1, count: 2 },
    rightFill: { cols: 1, rows: 2, count: 2 },
    count: 10,
    totalCount: 10,
    utilization: 0.5,
    spacingAxis: null, // 無 shrunk 輸入 → null
    strideX: 12, // pieceForCols(mb w=10)+gap(2)——與 bottomFullDirection 案例同一組 mb/gap/cols/rows
    strideY: 8, // pieceForRows(mb h=6)+gap(2)
    usedW: 22, // 10+(2-1)*12=22
    usedH: 22, // 6+(3-1)*8=22
  };

  it.each([
    { budget: NaN, label: 'NaN → 0' },
    { budget: -5, label: '負值 → 0' },
    { budget: -Infinity, label: '-Infinity → 0' },
    { budget: 0, label: '恰為 0 → 0（與負值是不同語意分支，各自獨立驗證）' },
  ])('$label', ({ budget }) => {
    expect(directionInstances(0, direction, mb, gripper, gap, budget)).toEqual([]);
  });

  // 極大 cols×rows（比照 instanceTransforms 既有「cap 惰性建構」回歸測試同款手法）：驗證
  // Infinity／1e9 正規化到 500 後，仍是 O(limit) 建構，不是先展開 O(cols×rows) 再截斷。
  const hugeMb: Bounds = { minX: 0, maxX: 0.01, minY: 0, maxY: 0.01 };
  const hugeMainDirection: DirectionResult = {
    cols: 332_226,
    rows: 332_226,
    gridCount: 332_226 * 332_226,
    fillSplit: 'bottom-full',
    bottomFill: { cols: 332_226, rows: 332_226, count: 332_226 * 332_226 },
    rightFill: { cols: 332_226, rows: 332_226, count: 332_226 * 332_226 },
    count: 0,
    totalCount: 0,
    utilization: 0,
    spacingAxis: null, // 無 shrunk 輸入 → null
    strideX: 0.01 + 3, // pieceForCols(hugeMb w=0.01)+gap(3，見下方呼叫)＝矩形 stride
    strideY: 0.01 + 3, // pieceForRows(hugeMb h=0.01)+gap(3)
    usedW: 0.01 + (332_226 - 1) * (0.01 + 3), // n≥1：piece+(n-1)*stride，比照 gridCount 既有算式風格用運算式而非手算常數
    usedH: 0.01 + (332_226 - 1) * (0.01 + 3),
  };

  it('Infinity → 硬限 500（主格點本身已超過上限，立即回傳、耗時 <1 秒）', () => {
    const start = Date.now();
    const result = directionInstances(0, hugeMainDirection, hugeMb, 0, 3, Infinity);
    expect(result).toHaveLength(MAX_PREVIEW_INSTANCES);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('1e9 → 硬限 500（有限但超大的 budget 也走同一條硬限路徑）', () => {
    const result = directionInstances(0, hugeMainDirection, hugeMb, 0, 3, 1e9);
    expect(result).toHaveLength(MAX_PREVIEW_INSTANCES);
  });

  it('主格點很小、補排條帶極大（cap 惰性建構延伸到補排分支，不只主格點分支）→ 硬限 500、耗時 <1 秒', () => {
    const direction: DirectionResult = {
      cols: 1,
      rows: 1,
      gridCount: 1,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 332_226, rows: 332_226, count: 332_226 * 332_226 },
      rightFill: { cols: 0, rows: 0, count: 0 },
      count: 0,
      totalCount: 0,
      utilization: 0,
      spacingAxis: null, // 無 shrunk 輸入 → null
      strideX: 0.01 + 3, // pieceForCols(hugeMb w=0.01)+gap(3，見下方呼叫)，與 hugeMainDirection 同一組 hugeMb/gap
      strideY: 0.01 + 3, // pieceForRows(hugeMb h=0.01)+gap(3)
      usedW: 0.01, // n=1：cols-1=0 → piece+0*stride=piece=0.01
      usedH: 0.01, // n=1：rows-1=0 → piece+0*stride=piece=0.01
    };
    const start = Date.now();
    const result = directionInstances(0, direction, hugeMb, 0, 3, 1e9);
    expect(result).toHaveLength(MAX_PREVIEW_INSTANCES); // 1 主格點 + 499 補排
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ── sectionOffsets（task-2） ─────────────────────────────────────────────

describe('sectionOffsets — 子紙左上角偏移（全紙座標系），四情境＋順序固定左上→右上→左下→右下', () => {
  const BASE_SHEET: WorkingSheet = {
    w: 100,
    h: 200,
    usableW: 90,
    usableH: 190,
    fullW: 100,
    fullH: 200,
    cutV: false,
    cutH: false,
    sections: 1,
  };

  it.each([
    { label: '整紙（不切）→ 單一 {0,0}', overrides: {}, expected: [{ dx: 0, dy: 0 }] },
    {
      label: 'cutV only → 左、右（半寬=fullW/2=50）',
      overrides: { cutV: true, w: 50, sections: 2 },
      expected: [
        { dx: 0, dy: 0 },
        { dx: 50, dy: 0 },
      ],
    },
    {
      label: 'cutH only → 上、下（半高=fullH/2=100）',
      overrides: { cutH: true, h: 100, sections: 2 },
      expected: [
        { dx: 0, dy: 0 },
        { dx: 0, dy: 100 },
      ],
    },
    {
      label: '四開（cutV+cutH）→ 左上/右上/左下/右下 四張',
      overrides: { cutV: true, cutH: true, w: 50, h: 100, sections: 4 },
      expected: [
        { dx: 0, dy: 0 },
        { dx: 50, dy: 0 },
        { dx: 0, dy: 100 },
        { dx: 50, dy: 100 },
      ],
    },
  ])('$label', ({ overrides, expected }) => {
    expect(sectionOffsets({ ...BASE_SHEET, ...overrides })).toEqual(expected);
  });

  it('讀旗標不猜尺寸：w===fullW（尺寸完全看不出裁切痕跡）時仍依 cutV=true 回傳 2 段', () => {
    // 故意讓 w 沒有真的取半（正常 resolveWorkingSheet 不會產生這種組合，但本函式的契約是
    // 「讀旗標」不是「讀尺寸差」——用尺寸差反推會在這裡誤判成「沒切」，見 brief RED 條款。
    const sheet: WorkingSheet = { ...BASE_SHEET, cutV: true, w: 100, fullW: 100, sections: 2 };
    expect(sectionOffsets(sheet)).toEqual([
      { dx: 0, dy: 0 },
      { dx: 50, dy: 0 },
    ]);
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
