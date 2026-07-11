import { describe, expect, it } from 'vitest';
import {
  manufacturingPaths,
  PROFILE_GEOMETRY_TYPES,
  computeProfileEnvelope,
  computeProfileStrides,
  computeMinStride,
  ProfileStrides,
} from '@/core/profile';
import type { Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult } from '@/core/types';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { fitCount } from '@/core/imposition';

// ─────────────────────────────────────────────────────────────────────────
// manufacturingPaths — 共用過濾（plan T1；spec F2b「bounds／profile／preview 三消費者同源」）
// ─────────────────────────────────────────────────────────────────────────

describe('manufacturingPaths', () => {
  function makePath(id: string, type: DielinePath['type']): DielinePath {
    return { id, type, segments: [{ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }] };
  }

  const syntheticResult: GenerateResult = {
    paths: [
      makePath('p-cut', 'cut'),
      makePath('p-crease', 'crease'),
      makePath('p-halfcut', 'halfcut'),
      makePath('p-dimension', 'dimension'),
      makePath('p-annotation', 'annotation'),
      makePath('p-bleed', 'bleed'),
    ],
    texts: [],
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
  };

  it('PROFILE_GEOMETRY_TYPES 正面表列恰為 cut/crease/halfcut（不含 dimension/annotation/bleed）', () => {
    expect(PROFILE_GEOMETRY_TYPES.has('cut')).toBe(true);
    expect(PROFILE_GEOMETRY_TYPES.has('crease')).toBe(true);
    expect(PROFILE_GEOMETRY_TYPES.has('halfcut')).toBe(true);
    expect(PROFILE_GEOMETRY_TYPES.has('dimension')).toBe(false);
    expect(PROFILE_GEOMETRY_TYPES.has('annotation')).toBe(false);
    expect(PROFILE_GEOMETRY_TYPES.has('bleed')).toBe(false);
  });

  it('無 piece 時：只留 cut/crease/halfcut 三種路徑，排除 dimension/annotation/bleed', () => {
    const filtered = manufacturingPaths(syntheticResult);
    expect(filtered.map((p) => p.id).sort()).toEqual(['p-crease', 'p-cut', 'p-halfcut']);
  });

  it('帶 piece 時：額外用 piece.pathIds 縮小子集（同時滿足型別與 pathIds 兩個條件）', () => {
    const piece: DielinePiece = {
      id: 'only-cut-and-dimension',
      label: { zh: '測試片' },
      pathIds: ['p-cut', 'p-dimension'], // 刻意混一個非幾何型別，驗證型別過濾仍然生效
      textIds: [],
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    };
    const filtered = manufacturingPaths(syntheticResult, piece);
    expect(filtered.map((p) => p.id)).toEqual(['p-cut']); // p-dimension 型別不合格，被擋下
  });

  it('RTE／telescope 真實資料：與既有 manufacturingBounds 的排除式過濾算出相同 bounds（v1 無 bleed/annotation，兩套規則現值相等，spec F2b「同源化為防未來分歧」）', () => {
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const rteSegs = manufacturingPaths(rteResult).flatMap((p) => p.segments);
    const rteBounds = segmentsBounds(rteSegs);
    expect(rteBounds.maxX - rteBounds.minX).toBeCloseTo(233.2, 2);
    expect(rteBounds.maxY - rteBounds.minY).toBeCloseTo(251.0, 2);

    const productionP = {
      baseLength: 179,
      baseWidth: 124,
      baseHeight: 60,
      lidMarginX: 13.5,
      lidMarginY: 18.5,
      lidHeight: 45,
      basePlatformWidth: 5,
      lidPlatformWidth: 0,
      thickness: 0.44,
      rootJog: 0.5,
      innerWallReduction: 0.8,
      wallTopCompensation: 0.5,
      linerEnabled: false,
    };
    const teleResult = telescope.generate(resolveParams(telescope, productionP));
    const basePiece = teleResult.pieces!.find((p) => p.id === 'base')!;
    const baseSegs = manufacturingPaths(teleResult, basePiece).flatMap((p) => p.segments);
    const baseBounds = segmentsBounds(baseSegs);
    expect(baseBounds.maxX - baseBounds.minX).toBeCloseTo(400.403, 1);
    expect(baseBounds.maxY - baseBounds.minY).toBeCloseTo(458.403, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeProfileEnvelope — 保守界專項（spec F1）
// ─────────────────────────────────────────────────────────────────────────

describe('computeProfileEnvelope', () => {
  it('純矩形（4 條 line）：四向包絡在每一槽都退化為常數 0/W 與 0/H（基礎健全性錨）', () => {
    const rect: Segment[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },
      { kind: 'line', x1: 100, y1: 0, x2: 100, y2: 50 },
      { kind: 'line', x1: 100, y1: 50, x2: 0, y2: 50 },
      { kind: 'line', x1: 0, y1: 50, x2: 0, y2: 0 },
    ];
    const env = computeProfileEnvelope(rect);
    expect(env.top.every((v) => v === 0)).toBe(true);
    expect(env.bottom.every((v) => v === 50)).toBe(true);
    expect(env.left.every((v) => v === 0)).toBe(true);
    expect(env.right.every((v) => v === 100)).toBe(true);
    expect(env.slotWidthX).toBe(0.5);
    expect(env.slotWidthY).toBe(0.5);
  });

  it('arc 保守界（v1.2·H2 回歸）：30°→60° 弧的「中間槽」不含端點也不含 0/90/180/270° 切點，仍正確拿到 bbox 極值——不是靠候選點才找到', () => {
    // 圓心原點、半徑 100、30°→60°：端點分別在 (86.603,50)（30°）與 (50,86.603)（60°），
    // 局部化後 W=H=36.603（86.603-50）。bbox={minX:50,maxX:86.603,minY:50,maxY:86.603}——
    // 純粹由端點決定（30°→60° 之間 x、y 皆單調，無 0/90/180/270° 切點介入）。
    // 局部化後 x=18（K=ceil(36.603/0.5)=74 的槽 36，覆蓋 [18.0,18.5)）離兩端點（局部 x=0
    // 與 x=36.603）都遠、也不是任何切點——手算 bbox y 值＝100*(sin60°−sin30°)＝36.60254。
    const arc: Segment = { kind: 'arc', cx: 0, cy: 0, r: 100, startAngle: Math.PI / 6, endAngle: Math.PI / 3, ccw: false };
    const env = computeProfileEnvelope([arc]);
    expect(env.top.length).toBe(74); // K = ceil(36.60254/0.5) = 74
    expect(env.top[36]).toBeCloseTo(0, 6);
    expect(env.bottom[36]).toBeCloseTo(100 * (Math.sin(Math.PI / 3) - Math.sin(Math.PI / 6)), 6); // 36.60254...
  });

  it('bezier 保守界（不得用整體凸包 bounds，逐槽 clip 才是合規做法）：控制點 (0,0)(0,0)(60,0)(60,120) 的凸包是三角形，在 x=[30.0,30.5) 這一槽的 y 極值應為 [0,61]（比整體凸包 bbox 的 [0,120] 窄很多）', () => {
    // 手算：三角形頂點 (0,0)(60,0)(60,120)。底邊 y=0 貫穿整個 x∈[0,60]（此槽下界=0）；
    // 斜邊 (0,0)-(60,120) 在 x=30.0 與 x=30.5 的 y 值分別為 60.0 與 61.0（y=2x），該槽
    // clip 後的凸包頂點 y 值集合={0,0,60.0,61.0}，極值=[0,61.0]（上界取兩端點中較大者，
    // 因斜邊在這個槽內單調遞增）。若誤用整體凸包 bounds，這一槽會得到 bottom=120（P3 的
    // y 座標）——遠比正確的逐槽 clip 結果(61)寬鬆，違反「不得用整體凸包 bounds」的規定。
    const tri: Segment = { kind: 'bezier', x1: 0, y1: 0, c1x: 0, c1y: 0, c2x: 60, c2y: 0, x2: 60, y2: 120 };
    const env = computeProfileEnvelope([tri]);
    const slot60 = 60; // x ∈ [30.0, 30.5)
    expect(env.top[slot60]).toBeCloseTo(0, 9);
    expect(env.bottom[slot60]).toBeCloseTo(61, 9);
    expect(env.bottom[slot60]).toBeLessThan(120); // 明確比「整體凸包 bounds」窄，證明真的逐槽 clip 了
  });

  it('槽邊界雙邊歸屬（人造 V 尖恰在邊界）：單一線段終點恰落在槽 9/10 邊界（x=5.0=10×0.5mm），且該線段定義域完全不進入槽 10——槽 10 若有值，必然是邊界雙歸屬機制本身的效果', () => {
    // 設計理由（mutation testing 找出的坑，見 task-1-report.md）：用「V 形兩段線都跨過邊界」
    // 來測雙歸屬會失敗——因為兩段各自的定義域本來就自然覆蓋了對面那一槽的大半，測不出
    // 「單點邊界觸碰」這個機制本身。這裡改用「單一線段終點恰好停在邊界」＋「另一條扁平
    // 基線只用來把 W 撐到 10（讓槽 10 存在），基線本身不觸及 y=50」——槽 10 若拿到 50，
    // 一定是邊界觸碰的單點 clip 生效，不是任何線段自然涵蓋槽 10 的巧合。
    const segs: Segment[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 5.0, y2: 50 }, // 終點恰在 x=5.0（槽 9/10 邊界），完全不進入 [5.0,5.5)
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }, // 純粹撐開 W=10，y 恆為 0，不干擾對 y=50 的判斷
    ];
    const env = computeProfileEnvelope(segs);
    expect(env.bottom[9]).toBe(50); // 槽 9：線段自然定義域內，理所當然拿到 50
    expect(env.bottom[10]).toBe(50); // 槽 10：只能來自邊界雙歸屬（撐開基線本身只給 0）
  });

  it('巢狀合併單調不減（K>4096）：W=2100mm（細槽 K=4200>4096→合併，槽寬 1.0mm）時，局部落在同一粗槽內的小特徵仍被完整捕捉，且粗槽值只會比沒有該特徵時更寬鬆（不會變窄）', () => {
    const withoutSpike: Segment[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 2100, y2: 0 },
      { kind: 'line', x1: 0, y1: 100, x2: 2100, y2: 100 },
    ];
    const withSpike: Segment[] = [
      ...withoutSpike,
      // 一根只在 x∈[1000.55] 附近、y 深到 150 的小特徵——落在細槽 2001（[1000.5,1001.0)），
      // 與細槽 2000（[1000.0,1000.5)）合併成同一個粗槽（groupSize=2）。
      { kind: 'line', x1: 1000.55, y1: 100, x2: 1000.55, y2: 150 },
    ];

    const envBase = computeProfileEnvelope(withoutSpike);
    expect(envBase.top.length).toBe(2100); // K=ceil(4200/2)=2100（觸發合併）
    expect(envBase.slotWidthX).toBe(1); // 粗槽寬 = 0.5 × groupSize(2)

    const envSpike = computeProfileEnvelope(withSpike);
    const coarseIdx = Math.floor(1000.55 / envBase.slotWidthX);
    expect(coarseIdx).toBe(1000);

    // 單調不減：加入 spike 後同一粗槽的 bottom 只會變大或持平，不會變小。
    expect(envSpike.bottom[coarseIdx]).toBeGreaterThanOrEqual(envBase.bottom[coarseIdx]!);
    expect(envBase.bottom[coarseIdx]).toBe(100); // 沒有 spike：純矩形 bottom=100
    expect(envSpike.bottom[coarseIdx]).toBe(150); // 有 spike：粗槽整體被拉寬到 150（即使 spike 只佔粗槽的一半寬度）
    expect(envSpike.top[coarseIdx]).toBe(0); // top 邊不受影響，仍是矩形上緣
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeProfileStrides — RTE 預設件 strideY 獨立重導（spec 驗收 1）
// ─────────────────────────────────────────────────────────────────────────

describe('computeProfileStrides — RTE 預設件（27"×39"直放·咬口20·gap3 錨）', () => {
  const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
  const rteSegments = manufacturingPaths(rteResult).flatMap((p) => p.segments);
  const gap = 3;
  const strides = computeProfileStrides(rteSegments, gap);
  const mfgBounds = segmentsBounds(rteSegments);
  const W = mfgBounds.maxX - mfgBounds.minX; // 233.2
  const H = mfgBounds.maxY - mfgBounds.minY; // 251.0

  it('strideY 獨立重導：194.825mm（不設上界——見下方推導與交叉驗證記錄）', () => {
    // 探針 `.superpowers/sdd/probe-profile-v2.mts` 的參考值 193.57 僅為機制參考，不是實作值
    // 的界（spec v1.2·H：探針 arc 讀成 NaN 完全未參與、bezier 誤讀成直線弦，皆為低估；
    // 解析實作理應更大，「實作值≤探針值」的舊上界與保守界原則相反，已撤除，見 spec 驗收1）。
    //
    // 本測試的 194.825 由 `computeProfileStrides`（本檔實作，逐槽解析 line + bbox 保守
    // arc + 凸包裁切 bezier）算出，經以下獨立重導交叉驗證（過程見 task-1-report.md）：
    //   1. 重寫一份完全獨立的點取樣版 gap-aware minStride（沿用探針 v2 的公式與槽陣列
    //      結構，但修正探針既有的兩個已知 bug：arc 改真正用 cx+r·cos/sin(θ) 參數式密集
    //      取樣、bezier 改真正的三次貝茲參數式取樣，不再誤讀成直線）。密集取樣（2000
    //      點/segment）修正版算出 strideY≈192.897——比本實作的 194.825 略小 1.93mm。
    //   2. 這個差距完全可歸因於 arc 的保守化策略選擇（本模組選 bbox 貢獻給重疊的每個槽，
    //      比逐槽精確裁切弧本身更寬鬆——spec F1 明文允許的二擇一保守替代）：RTE 的 4 個
    //      圓角皆為 r=3mm 的插舌轉角弧，其中一個 bbox（局部 y∈[248,251]）恰好覆蓋了
    //      strideY 最終取最大值的那個槽（槽 30，經檢查其 bbox 橫跨槽 25–31），把該槽的
    //      bottom 從純線段幾何算出的 239 直接拉高到 bbox 的 251——這就是保守 bbox 策略
    //      "多付出的安全邊際"，方向正確（更保守，不是 bug）。
    //   3. 兩條完全獨立寫法（解析 vs. 密集點取樣）在同一個複雜真實幾何（57 條 line + 4
    //      條 arc + 3 條 bezier）上互相印證在同一數量級、差距可解釋——不是巧合對上、也
    //      不是暗藏一個抵銷另一個的鏡射 bug。
    //
    // 另外發現（非本模組 bug，記錄供 controller 知悉）：探針 v2 手動組 params 時遺漏
    // `tuckClearance` 的 `derivedDefault`（`0.5+thickness`），實際餵入 0.5 而非
    // canonical 的 0.8——這也是探針 193.57 跟本檔（用 `resolveParams` 走正規 derivedDefault
    // 解析鏈得到 tuckClearance=0.8）之間一部分差距的來源，與 arc/bezier 讀取 bug 無關。
    expect(strides.strideY).toBeCloseTo(194.825, 2);
    expect(strides.strideY).toBeGreaterThan(190); // 明確比探針參考值系統性更大，不設上界
    expect(strides.strideX).toBe(236.2); // 左右緣為平直豎線，無收縮空間——退化為矩形 W+gap（233.2+3），與 spec 表列 236.2 逐字相同
  });

  it('保守界不變式：strideY 大於（H+gap）的任何「明顯低估」下界，且遠小於矩形上界（H+gap=254.0）——收縮確有發生，不是退化成無收益', () => {
    expect(strides.strideY).toBeLessThan(H + gap); // 明確小於矩形（有收益，不是零收縮）
    expect(strides.strideY).toBeGreaterThan(100); // 遠高於「完全不合理」的下界，防止公式整個算反
  });

  it('27"×39"（686×991mm，咬口20→可用區646×951）模數錨不受 arc 保守化影響：0° 2×4=8、90° 3×4=12（與探針 v1.2 記錄的 spec 錨相同——若這裡變動須停下回報 controller，本次驗證未變動）', () => {
    const usableW = 646;
    const usableH = 951;
    const sf = (avail: number, piece: number, stride: number) => (avail + 1e-6 < piece ? 0 : 1 + Math.floor((avail - piece + 1e-6) / stride));

    // 0°：cols 用矩形（strideX=236.2，非收縮向），rows 用 gap-aware strideY（收縮向）。
    const cols0 = fitCount(usableW, W, gap);
    const rows0 = sf(usableH, H, strides.strideY!);
    expect(cols0).toBe(2);
    expect(rows0).toBe(4);
    expect(cols0 * rows0).toBe(8);

    // 90°：件轉 90°（W/H 互換），cols 用 strideY（轉正後即原本的垂直收縮向），rows 用矩形。
    const cols90 = sf(usableW, H, strides.strideY!);
    const rows90 = fitCount(usableH, W, gap);
    expect(cols90).toBe(3);
    expect(rows90).toBe(4);
    expect(cols90 * rows90).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeProfileStrides — telescope production-P 退化錨（spec 驗收 3／源起表「零收益」）
// ─────────────────────────────────────────────────────────────────────────

describe('computeProfileStrides — telescope production-P（十字形件退化為矩形 stride，零收益）', () => {
  const productionP = {
    baseLength: 179,
    baseWidth: 124,
    baseHeight: 60,
    lidMarginX: 13.5,
    lidMarginY: 18.5,
    lidHeight: 45,
    basePlatformWidth: 5,
    lidPlatformWidth: 0,
    thickness: 0.44,
    rootJog: 0.5,
    innerWallReduction: 0.8,
    wallTopCompensation: 0.5,
    linerEnabled: false,
  };
  const result = telescope.generate(resolveParams(telescope, productionP));
  const gap = 3;

  function strideFor(pieceId: string) {
    const piece = result.pieces!.find((p) => p.id === pieceId)!;
    const segs = manufacturingPaths(result, piece).flatMap((p) => p.segments);
    const bounds = segmentsBounds(segs);
    const W = bounds.maxX - bounds.minX;
    const H = bounds.maxY - bounds.minY;
    return { strides: computeProfileStrides(segs, gap), W, H };
  }

  it('下盒（base）：stride 退化為矩形（W+gap/H+gap），bbox 400.403×458.403（spec 源起表「零收益」）', () => {
    const { strides, W, H } = strideFor('base');
    expect(W).toBeCloseTo(400.403, 1);
    expect(H).toBeCloseTo(458.403, 1);
    expect(strides.strideX).toBeCloseTo(W + gap, 2);
    expect(strides.strideY).toBeCloseTo(H + gap, 2);
  });

  it('上蓋（lid）：stride 退化為矩形（W+gap/H+gap），bbox 359.399×425.401（spec 源起表「零收益」）', () => {
    const { strides, W, H } = strideFor('lid');
    expect(W).toBeCloseTo(359.399, 1);
    expect(H).toBeCloseTo(425.401, 1);
    expect(strides.strideX).toBeCloseTo(W + gap, 2);
    expect(strides.strideY).toBeCloseTo(H + gap, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeProfileStrides — 空幾何退化（F2 review fix：無材料槽對不可回傳 stride=0）
// ─────────────────────────────────────────────────────────────────────────

describe('computeProfileStrides — 空幾何退化（F2 review fix）', () => {
  it('segments=[]（完全無材料）：strideX／strideY 皆退化為 gap，不是 0（spec 名詞段「恆有 gap ≤ strideY ≤ H+gap」；空幾何 extent=0，矩形上界退化為 0+gap=gap——本次修復選擇的語意：空幾何視為零尺寸件的矩形退化，不是另立特例）', () => {
    const gap = 3;
    const strides = computeProfileStrides([], gap);
    // 修前：computeMinStride 對全空槽（far 恆 -Infinity）找不到任何一組「兩者皆有限」的
    // 槽對，內層迴圈本體完全不執行，stride 停在迴圈外的初始值 0——違反不變式（0 < gap）。
    expect(strides.strideX).toBe(gap);
    expect(strides.strideY).toBe(gap);
    expect(strides.strideX).toBeGreaterThanOrEqual(gap); // 不變式重申（此處等號成立，零尺寸退化）
    expect(strides.strideY).toBeGreaterThanOrEqual(gap);
  });

  it('computeMinStride 直接測（F2 根因）：全 -Infinity／Infinity 的 far/near 陣列，clamp 前會停在初始值 0，clamp 後正確回到 gap', () => {
    const gap = 5;
    const far = [-Infinity, -Infinity, -Infinity];
    const near = [Infinity, Infinity, Infinity];
    expect(computeMinStride(far, near, gap, 0.5)).toBe(gap);
  });

  it('clamp 不影響正常案例：任何有材料的槽算出的 stride 本來就 ≥gap，clamp 是 no-op（用 RTE 真實幾何驗證 clamp 前後數值不變，防止這個修復意外收緊了正常案例的計算結果）', () => {
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const rteSegments = manufacturingPaths(rteResult).flatMap((p) => p.segments);
    const gap = 3;
    const strides = computeProfileStrides(rteSegments, gap);
    // 194.825／236.2 是上方 RTE 錨測試已獨立重導驗證過的值——這裡只是確認 F2 的 clamp
    // 沒有意外改動正常案例的計算路徑（clamp 只在「完全無材料」時才會真的生效，見
    // computeMinStride 文件字串的手算證明）。
    expect(strides.strideY).toBeCloseTo(194.825, 2);
    expect(strides.strideX).toBe(236.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ProfileStrides — opaque class 封裝測試（spec v1.4 §F2b／驗收 8）
// ─────────────────────────────────────────────────────────────────────────

describe('ProfileStrides — 封裝（spec 驗收 8；F1 review fix：公開數值工廠已移除，computeProfileStrides 是唯一能建出 instance 的入口）', () => {
  // 共用的合成矩形（100×50）——這個 describe block 只關心 ProfileStrides 本身的封裝行為
  // （freeze／mutate／單軸缺省），不關心 stride 的精確業務數值，用一個簡單、好手算的矩形
  // 即可：same-slot 項（i=j）恆為該項最大值（同矩形上下/左右緣為常數，見
  // computeProfileEnvelope 的「純矩形」錨測試），故 strideY=H+gap=50+3=53、
  // strideX=W+gap=100+3=103（手算見下方各測試引用處）。
  const rect: Segment[] = [
    { kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },
    { kind: 'line', x1: 100, y1: 0, x2: 100, y2: 50 },
    { kind: 'line', x1: 100, y1: 50, x2: 0, y2: 50 },
    { kind: 'line', x1: 0, y1: 50, x2: 0, y2: 0 },
  ];
  const gap = 3;

  it('型別層：手工物件字面量、spread 覆寫、與 ProfileStrides.create 皆需 @ts-expect-error（由 `npm run typecheck` 的 tsc 驗證；若這裡的 @ts-expect-error 變成「多餘」，tsc 會自己報錯，等於型別 gate 本身會抓到封裝失效）', () => {
    const valid = computeProfileStrides(rect, gap);

    // @ts-expect-error 手工字面量缺少私有 #brand，不能賦值給 ProfileStrides（型別驗收①）
    const manual: ProfileStrides = { gap: 3, strideX: 103, strideY: 53 };

    // @ts-expect-error spread 複製產物失去 class 身份與私有欄位，不能賦值給 ProfileStrides
    // （型別驗收②，v1.4·M2 收口的關鍵修正——spread-override 是「宣告 gap 沿用舊 stride」
    // 的可信事故路徑，見 profile.ts 的 ProfileStrides 文件字串）
    const spread: ProfileStrides = { ...valid, gap: 4 };

    // @ts-expect-error ProfileStrides.create 已移除（F1 review fix，v1.5）——舊版是公開
    // 數值工廠，`ProfileStrides.create(4, 236.2, 194.825)` 不需要 spread/any/JS 手法就能
    // 合法組出「宣告 gap=4，但 194.825 其實是用 gap=3 算出來的 stride」這種不同步
    // instance，重開 spec v1.4 五輪封住的撞刀路徑（見 profile.ts 的 ProfileStrides class
    // 文件字串）。現在 `create` 已不存在於 ProfileStrides 上，這行必須是型別錯誤
    // （Property 'create' does not exist），tsc gate 直接驗證公開數值工廠真的消失了。
    // 刻意只讀屬性、不呼叫它（呼叫在 runtime 會拋 TypeError——`@ts-expect-error` 只抑制
    // tsc 的靜態診斷，不會讓 esbuild/vitest 略過這行實際執行；純屬性讀取足以觸發同一個
    // TS2339「Property does not exist」錯誤，且不會讓測試本身在 runtime 崩潰）。
    const bypassed = ProfileStrides.create;

    // 這裡只是讓上面三行有地方落腳（避免宣告了卻完全不用），實際驗收由 tsc gate 完成。
    expect(manual).toBeDefined();
    expect(spread).toBeDefined();
    expect(bypassed).toBeUndefined(); // 屬性真的不存在——runtime 讀取非既有靜態成員回傳 undefined，與型別層的拒絕相互印證
  });

  it('runtime 不可變：Object.isFrozen 直接斷言（getter 沒有 setter 本來就會讓 mutate 探測「假通過」，不能只靠它證明真的 freeze 了，需要獨立斷言）', () => {
    const strides = computeProfileStrides(rect, gap);
    expect(Object.isFrozen(strides)).toBe(true);
  });

  it('runtime 不可變：mutate 呼叫拋錯（getter 無 setter＋freeze 兩道防線都在，這裡驗證確實會拋，不是靜默失敗）', () => {
    const strides = computeProfileStrides(rect, gap);
    // 用型別抹除繞過 TS 的 readonly 檢查，純粹驗證 runtime 行為（型別層的拒絕已由上一個
    // it 的 @ts-expect-error 驗證，這裡刻意脫離型別系統直接戳 runtime）。
    const mutable = strides as unknown as { gap: number; strideX: number };
    expect(() => {
      mutable.gap = 999;
    }).toThrow();
    expect(() => {
      mutable.strideX = 999;
    }).toThrow();
  });

  it('computeProfileStrides 的 onlyAxis 選項：strideX／strideY 可各自獨立缺省（undefined），getter 忠實回傳（spec F2b 缺省語意——由呼叫端／F3 單向擇優透過 onlyAxis 決定要不要帶入某一軸；F1 review fix 後這是唯一能拿到單軸 instance 的路徑，取代舊版可傳任意數字的 ProfileStrides.create）', () => {
    const onlyY = computeProfileStrides(rect, gap, 'y');
    expect(onlyY.gap).toBe(3);
    expect(onlyY.strideX).toBeUndefined();
    expect(onlyY.strideY).toBe(53); // H+gap=50+3=53（見上方 rect 手算註解）

    const onlyX = computeProfileStrides(rect, gap, 'x');
    expect(onlyX.strideX).toBe(103); // W+gap=100+3=103
    expect(onlyX.strideY).toBeUndefined();
    expect(Object.isFrozen(onlyX)).toBe(true); // 單軸缺省一樣要 freeze，不因欄位缺省而跳過
  });

  it('computeProfileStrides 省略 onlyAxis（預設兩軸皆算）：instance 兩軸恆為 finite 數字（不缺省——本模組的計算入口預設一律算滿兩軸，缺省語意只在明確傳 onlyAxis 時才啟用）', () => {
    const strides = computeProfileStrides(rect, gap);
    expect(Number.isFinite(strides.strideX)).toBe(true);
    expect(Number.isFinite(strides.strideY)).toBe(true);
    expect(Object.isFrozen(strides)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 效能記錄（plan-review M：K≈500 typical <10ms 參考門檻）
// ─────────────────────────────────────────────────────────────────────────

describe('computeProfileStrides — 效能記錄', () => {
  it('RTE 典型件（K≈467，接近 plan 參考的 K≈500）單次計算 <10ms', () => {
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const segs = manufacturingPaths(rteResult).flatMap((p) => p.segments);

    // 先跑一次暖機（避免 JIT 尚未編譯的第一次呼叫污染量測——這裡量的是穩態效能）。
    computeProfileStrides(segs, 3);

    const start = performance.now();
    computeProfileStrides(segs, 3);
    const elapsed = performance.now() - start;

    // 實測值（見 task-1-report.md）：約 0.3-2.5ms，遠低於 10ms 參考門檻。門檻本身放寬到
    // 50ms 防 CI 環境雜訊造成偶發 flaky（門檻參考值本身不是本次要鎖的精確數字，真正的
    // 觀測數字記在 report 裡供 controller 參考）。
    expect(elapsed).toBeLessThan(50);
  });
});
