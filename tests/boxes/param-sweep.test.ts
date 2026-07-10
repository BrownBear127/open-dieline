/**
 * RTE 參數邊界掃描（T9 樣張 gate 第二輪驗收反饋，修復 2B）。
 *
 * 目的：假旋鈕測試只驗證「每個參數有接線」，等價/golden 測試只跑預設參數——三者都不覆蓋
 * 「單一參數推到 min/max」或「多個參數同時推到極端」時是否會讓 generate() 整個崩潰
 * （throw）或算出 NaN。這支測試不判斷幾何「對不對」（不變式可以 not-ok，警告本來就是
 * 預期行為），只判斷「不崩潰、無 NaN、bounds 有限」這條最低限度的安全網，把還沒被發現的
 * 退化參數組合整批翻出來。
 *
 * 兩層掃描：
 * 1. 單一 number 參數各取 min/max（其餘維持預設）——11 個 mm 單位參數 × 2 = 22 案例
 *    （glueSide 是 enum，沒有 min/max，不在此列，見下方 describe 內的 filter 條件）。
 * 2. 20 組寫死的多參數組合（不用 Math.random，可重現）——針對前 6 個 task 報告與 T9
 *    Round 2 修復 1 診斷過程中，觀察到「多個參數同時取極端才會顯現交互作用」的區域
 *    （插舌鉗制三角關係 tuckRadius/tuckDepth/tuckClearance+L、摩擦扣 vs L、避讓槽 gap
 *    fallback 分支、糊邊、蓋板高 vs 插舌深度）逐一設計，覆蓋單一參數掃描測不到的組合爆炸。
 */
import { describe, it, expect } from 'vitest';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { hasNaN } from '@/core/geometry';

type Overrides = Partial<Record<string, number | boolean | string>>;

/** 對單一組參數斷言「安全網」三件事：generate() 不 throw、無 NaN、bounds 四個角皆為有限值。 */
function assertSafe(label: string, overrides: Overrides): void {
  it(`${label}：generate 不 throw、無 NaN、bounds 有限`, () => {
    let paths: ReturnType<typeof reverseTuckEnd.generate>['paths'] = [];
    let bounds: ReturnType<typeof reverseTuckEnd.generate>['bounds'] = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    expect(() => {
      const params = resolveParams(reverseTuckEnd, overrides);
      const result = reverseTuckEnd.generate(params);
      paths = result.paths;
      bounds = result.bounds;
    }, label).not.toThrow();

    const segs = paths.flatMap((p) => p.segments);
    expect(hasNaN(segs), `${label}：不應含 NaN 座標`).toBe(false);

    for (const [key, v] of Object.entries(bounds)) {
      expect(Number.isFinite(v), `${label}：bounds.${key} 應為有限值，實際為 ${v}`).toBe(true);
    }
  });
}

describe('RTE 參數邊界掃描（T9 Fix Round 2 修復 2B）', () => {
  describe('單一參數 min/max（其餘維持預設）', () => {
    for (const p of reverseTuckEnd.params) {
      // 只掃 number 類參數（unit='mm'|'deg'）；glueSide 是 enum，沒有 min/max 可掃。
      if (p.unit !== 'mm' && p.unit !== 'deg') continue;
      if (p.min !== undefined) assertSafe(`${p.key}=min(${p.min})`, { [p.key]: p.min });
      if (p.max !== undefined) assertSafe(`${p.key}=max(${p.max})`, { [p.key]: p.max });
    }
  });

  describe('20 組寫死的多參數組合（交互作用；不用亂數，可重現）', () => {
    const combos: { label: string; overrides: Overrides }[] = [
      {
        label: '1. 全部參數同時取 min',
        overrides: {
          L: 20, W: 20, D: 20, tuckDepth: 0, tuckRadius: 0, tuckClearance: 0,
          tuckLock: 0, dustFlapDepth: 0, flapNotch: 0, creaseRelief: 0, glueSize: 5,
        },
      },
      {
        label: '2. 全部參數同時取 max',
        overrides: {
          L: 500, W: 500, D: 500, tuckDepth: 60, tuckRadius: 15, tuckClearance: 10,
          tuckLock: 60, dustFlapDepth: 60, flapNotch: 20, creaseRelief: 20, glueSize: 60,
        },
      },
      {
        label: '3. tuckRadius=max 但 tuckDepth=min（鉗制應把 effectiveR 壓到 0）',
        overrides: { tuckRadius: 15, tuckDepth: 0 },
      },
      {
        label: '4. tuckRadius=max + tuckDepth=max + tuckClearance=max + L=min（插舌半寬鉗制到 0 的邊界情形）',
        overrides: { tuckRadius: 15, tuckDepth: 60, tuckClearance: 10, L: 20 },
      },
      {
        label: '5. tuckRadius=max + tuckDepth=max + tuckClearance=min + L=min（半寬鉗制生效但非 0）',
        overrides: { tuckRadius: 15, tuckDepth: 60, tuckClearance: 0, L: 20 },
      },
      {
        label: '6. tuckLock=max 遠超蓋板寬 L=min（frictionLock 幾何超出面板，仍不應崩潰）',
        overrides: { tuckLock: 60, L: 20 },
      },
      {
        label: '7. tuckLock=min（停用摩擦扣）+ 其餘鎖扣/插舌相關取 max',
        overrides: { tuckLock: 0, tuckDepth: 60, tuckRadius: 15 },
      },
      {
        label: '8. flapNotch=max + creaseRelief=min + dustFlapDepth=max（避讓槽 gap 走 flapNotch 分支）',
        overrides: { flapNotch: 20, creaseRelief: 0, dustFlapDepth: 60 },
      },
      {
        label: '9. flapNotch=min + creaseRelief=max（避讓槽 gap 走 creaseRelief 分支）',
        overrides: { flapNotch: 0, creaseRelief: 20 },
      },
      {
        label: '10. flapNotch=min + creaseRelief=min（reliefGap 落回 fallback 值 3）',
        overrides: { flapNotch: 0, creaseRelief: 0 },
      },
      {
        label: '11. glueSize=max + glueSide=right',
        overrides: { glueSize: 60, glueSide: 'right' },
      },
      {
        label: '12. glueSize=min + glueSide=left',
        overrides: { glueSize: 5, glueSide: 'left' },
      },
      {
        label: '13. W=min + D=max + L=max（薄蓋板＋長身體＋長面板）',
        overrides: { W: 20, D: 500, L: 500 },
      },
      {
        label: '14. W=max + D=min + L=min（巨大蓋板＋極短身體＋窄面板，hLid 主導 bounds）',
        overrides: { W: 500, D: 20, L: 20 },
      },
      {
        label: '15. tuckDepth=max + tuckRadius=min（大深度直角插舌）',
        overrides: { tuckDepth: 60, tuckRadius: 0 },
      },
      {
        label: '16. tuckDepth=min + tuckRadius=min + tuckClearance=max + L=min（零深度插舌退化為零寬度）',
        overrides: { tuckDepth: 0, tuckRadius: 0, tuckClearance: 10, L: 20 },
      },
      {
        label: '17. dustFlapDepth=min（零高度防塵翼）+ 其餘避讓參數 max',
        overrides: { dustFlapDepth: 0, flapNotch: 20, creaseRelief: 20 },
      },
      {
        label: '18. 插舌與避讓同時 max：tuckDepth/flapNotch/creaseRelief/dustFlapDepth 皆 max',
        overrides: { tuckDepth: 60, flapNotch: 20, creaseRelief: 20, dustFlapDepth: 60 },
      },
      {
        label: '19. tuckRadius=max + tuckClearance=max + tuckDepth=min + L=min（雙重鉗制路徑同時觸發）',
        overrides: { tuckRadius: 15, tuckClearance: 10, tuckDepth: 0, L: 20 },
      },
      {
        label: '20. W=min + tuckDepth=max（插舌深度遠超蓋板高）',
        overrides: { W: 20, tuckDepth: 60 },
      },
    ];

    it('寫死組合數應為 20（spec 要求，避免筆誤漏加/多加）', () => {
      expect(combos).toHaveLength(20);
    });

    for (const { label, overrides } of combos) {
      assertSafe(label, overrides);
    }
  });
});
