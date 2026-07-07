import { describe, it, expect } from 'vitest';
import {
  GLUE_CHAMFER,
  LOCK_HEIGHT,
  LOCK_CHAMFER,
  frictionLock,
  reliefSlot,
  dimensionLine,
} from '@/core/primitives';

// 全部手算數值依前身 ReverseTuckEnd.ts（唯讀參照，
// /Users/fran/Desktop/trouver.crm-rebuild/components/Tools/Packaging/models/ReverseTuckEnd.ts）
// 的 drawLock/drawRelief/drawDim/drawDimV 邏輯逐步推導；含 0.3 乘數的浮點值另外用
// node 腳本驗證過實際 IEEE-754 結果（不是憑十進位直覺假設），見各測試內註解。

describe('具名常數（前身 magic number 具名化）', () => {
  it('GLUE_CHAMFER=5／LOCK_HEIGHT=1.5／LOCK_CHAMFER=2，對齊前身字面值', () => {
    // 前身 ReverseTuckEnd.ts:106（Glue Flap `const chamfer = 5`）
    // 前身 ReverseTuckEnd.ts:132（drawLock `const h_lock = 1.5`）
    // 前身 ReverseTuckEnd.ts:138（drawLock `const chamfer = 2`）
    expect(GLUE_CHAMFER).toBe(5);
    expect(LOCK_HEIGHT).toBe(1.5);
    expect(LOCK_CHAMFER).toBe(2);
  });
});

describe('frictionLock（依 ReverseTuckEnd.ts:124-149 手算，xStart=0,xEnd=20,y=100,lockWidth=6）', () => {
  // cx=(0+20)/2=10；xLeft=10-6/2=7；xRight=10+6/2=13（兩側各留 chamfer=2 導角）
  it("dir='up'：cut 凸起方向為負（sign=-1→bumpY=100-1.5=98.5），creases 斷在卡榫邊緣", () => {
    const { creases, cut } = frictionLock(0, 20, 100, 'up', 6);
    expect(creases).toEqual([
      { kind: 'line', x1: 0, y1: 100, x2: 7, y2: 100 },
      { kind: 'line', x1: 13, y1: 100, x2: 20, y2: 100 },
    ]);
    expect(cut).toEqual([
      { kind: 'line', x1: 7, y1: 100, x2: 9, y2: 98.5 }, // 7+chamfer(2)=9
      { kind: 'line', x1: 9, y1: 98.5, x2: 11, y2: 98.5 }, // 13-chamfer(2)=11
      { kind: 'line', x1: 11, y1: 98.5, x2: 13, y2: 100 },
    ]);
  });

  it("dir='down'：cut 凸起方向為正（sign=+1→bumpY=100+1.5=101.5），與 up 鏡像、creases 不變", () => {
    const { creases, cut } = frictionLock(0, 20, 100, 'down', 6);
    expect(creases).toEqual([
      { kind: 'line', x1: 0, y1: 100, x2: 7, y2: 100 },
      { kind: 'line', x1: 13, y1: 100, x2: 20, y2: 100 },
    ]);
    expect(cut).toEqual([
      { kind: 'line', x1: 7, y1: 100, x2: 9, y2: 101.5 },
      { kind: 'line', x1: 9, y1: 101.5, x2: 11, y2: 101.5 },
      { kind: 'line', x1: 11, y1: 101.5, x2: 13, y2: 100 },
    ]);
  });

  it.each([0, -5])(
    'lockWidth<=0（%d）：cut 為空陣列，creases 為 xStart→xEnd 整段直線（前身 !w_lock||w_lock<=0 退化路徑）',
    (lockWidth) => {
      const { creases, cut } = frictionLock(0, 20, 100, 'up', lockWidth);
      expect(cut).toEqual([]);
      expect(creases).toEqual([{ kind: 'line', x1: 0, y1: 100, x2: 20, y2: 100 }]);
    },
  );

  it('lockWidth=NaN 也落入退化路徑（前身 `!w_lock` 對 NaN 為 true，屬隱性涵蓋，不只 brief 明文的 <=0）', () => {
    const { creases, cut } = frictionLock(0, 20, 100, 'up', NaN);
    expect(cut).toEqual([]);
    expect(creases).toEqual([{ kind: 'line', x1: 0, y1: 100, x2: 20, y2: 100 }]);
  });
});

describe('reliefSlot（依 ReverseTuckEnd.ts:151-165 手算，gap=3,notchHeight=3）', () => {
  it("side='left', dir='top'：xTarget=corner-gap=47，yCurveEnd=corner-notchHeight=-3", () => {
    const { cut, end } = reliefSlot(50, 0, 'left', 'top', 3, 3);
    expect(end).toEqual({ x: 47, y: -3 });
    expect(cut).toHaveLength(1);
    const bez = cut[0]!;
    if (bez.kind !== 'bezier') throw new Error('expected bezier segment');
    expect(bez.x1).toBe(50);
    expect(bez.y1).toBe(0);
    expect(bez.c1x).toBe(50);
    expect(bez.c1y).toBeCloseTo(-1.5, 9); // notchHeight*0.5*ySign = 3*0.5*-1
    expect(bez.c2x).toBe(47);
    // 3*0.3 在 IEEE-754 下非精確等於 0.9（node 實測 0.8999999999999999），
    // 用 toBeCloseTo 驗證幾何關係，不鎖死浮點雜訊位元
    expect(bez.c2y).toBeCloseTo(-0.9, 9);
    expect(bez.x2).toBe(47);
    expect(bez.y2).toBe(-3);
  });

  it("side='right', dir='bottom'：xTarget=corner+gap=53，yCurveEnd=corner+notchHeight=103（與 left/top 鏡像）", () => {
    const { cut, end } = reliefSlot(50, 100, 'right', 'bottom', 3, 3);
    expect(end).toEqual({ x: 53, y: 103 });
    expect(cut).toHaveLength(1);
    const bez = cut[0]!;
    if (bez.kind !== 'bezier') throw new Error('expected bezier segment');
    expect(bez.x1).toBe(50);
    expect(bez.y1).toBe(100);
    expect(bez.c1x).toBe(50);
    expect(bez.c1y).toBeCloseTo(101.5, 9); // 100+3*0.5*1
    expect(bez.c2x).toBe(53);
    expect(bez.c2y).toBeCloseTo(100.9, 9); // 100+3*0.3*1
    expect(bez.x2).toBe(53);
    expect(bez.y2).toBe(103);
  });

  // 解耦測試：上面兩組（left/top、right/bottom）side 與 dir 恰好同向搭配，
  // 若實作誤把 side/dir 的符號來源互換（ySign 誤讀 side、xGap 誤讀 dir）兩組測試會巧合通過。
  // 這裡刻意交叉搭配（side='right' 但 dir='top'）：x 方向應跟著 side 走正、y 方向應跟著 dir 走負，
  // 兩者不再同號，才能真正驗證兩個符號軸互相獨立、沒有接錯線。
  it("side='right', dir='top'（交叉搭配，解耦 side/dir 兩軸）：x 方向正、y 方向負", () => {
    const { cut, end } = reliefSlot(50, 0, 'right', 'top', 3, 3);
    expect(end).toEqual({ x: 53, y: -3 });
    expect(cut).toHaveLength(1);
    const bez = cut[0]!;
    if (bez.kind !== 'bezier') throw new Error('expected bezier segment');
    expect(bez.c1x).toBe(50);
    expect(bez.c1y).toBeCloseTo(-1.5, 9); // 0+3*0.5*(-1)
    expect(bez.c2x).toBe(53);
    expect(bez.c2y).toBeCloseTo(-0.9, 9); // 0+3*0.3*(-1)
  });
});

describe("dimensionLine（依 ReverseTuckEnd.ts:312-319 drawDim / 321-327 drawDimV 手算）", () => {
  it("orientation='h', offset=0：ly=y1=50，tick=-2（offset 非 >0，即使=0 仍外伸 2mm），text.rotation=0", () => {
    const { paths, text } = dimensionLine(0, 50, 30, 50, '30mm', 0, 'h');
    expect(paths).toEqual([
      { kind: 'line', x1: 0, y1: 50, x2: 0, y2: 48 }, // 引出線1：ly+tick=50+(-2)=48
      { kind: 'line', x1: 30, y1: 50, x2: 30, y2: 48 }, // 引出線2
      { kind: 'line', x1: 0, y1: 50, x2: 30, y2: 50 }, // 標註主線：y=ly=50
    ]);
    expect(text).toEqual({ x: 15, y: 48, text: '30mm', rotation: 0 }); // x=(0+30)/2=15，y=ly-2=48
  });

  it("orientation='h', offset=5(>0)：ly=5，tick=+2 方向反轉", () => {
    const { paths, text } = dimensionLine(0, 0, 10, 0, '10mm', 5, 'h');
    expect(paths).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 7 }, // ly+tick=5+2=7
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 7 },
      { kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5 }, // y=ly=5
    ]);
    expect(text).toEqual({ x: 5, y: 3, text: '10mm', rotation: 0 }); // y=ly-2=3
  });

  it("orientation='v', offset=-10：lx=-10，tick=-2，text.rotation=-90（前身 addText 明確傳 -90，非 90）", () => {
    const { paths, text } = dimensionLine(0, 0, 0, 100, '100mm', -10, 'v');
    expect(paths).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: -12, y2: 0 }, // lx+tick=-10+(-2)=-12
      { kind: 'line', x1: 0, y1: 100, x2: -12, y2: 100 },
      { kind: 'line', x1: -10, y1: 0, x2: -10, y2: 100 }, // x=lx=-10
    ]);
    expect(text).toEqual({ x: -14, y: 50, text: '100mm', rotation: -90 }); // x=lx-4=-14，y=(0+100)/2=50
  });
});
