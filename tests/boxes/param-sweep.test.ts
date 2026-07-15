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
import { telescope } from '@/boxes/telescope';
import { hasNaN } from '@/core/geometry';
import type { BoxModule, GenerateResult, ResolvedParams } from '@/core/types';

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

    it('寫死組合數應為 20（brief 要求，避免筆誤漏加/多加）', () => {
      expect(combos).toHaveLength(20);
    });

    for (const { label, overrides } of combos) {
      assertSafe(label, overrides);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// telescope（天地盒）：縮放降級矩陣 S1-S7（Slice 5 Task 5，spec §驗收 4「param-sweep
// 固定參數矩陣」——spec F5 段原文「既有 param-sweep 機制擴充：固定參數矩陣見 §驗收」，
// 這是該擴充在本檔的正式落地）。
//
// 與上方 RTE 區塊的關係：沿用同一套「安全網」哲學（generate 不 throw／無 NaN／bounds
// 有限），額外疊一層「warning unique-id 集合精確匹配」——比較對象＝telescope.invariants
// 全部（16 條，含 pieces-valid／liner-flap-fits／pieces-identity／rim-flush／
// gusset-b-fits／tongue-flap-fits／no-nan／no-bleed／bounds-cover 等既有 module
// invariant＋spec §縮放與降級規律表列出的 7 個「細節降級」id：notch-reduced／
// notch-omitted／platform-corner-omitted／gusset-relief-omitted／tongue-crease-shrunk／
// tongue-crease-omitted／relief-omitted）中實際觸發（check().ok===false）的完整集合，
// 不篩子集（2026-07-11 SOL review M1 修正——舊版只收集上述 7 個新降級 id、把既有 module
// invariant 排除在集合外；spec §驗收 4 表 S3 明列「＋既有 tongue-flap-fits（如觸發）」，
// 可見既有 invariant 觸發與否本就是預期集合的一部分，舊篩選下這條既有 warning 意外出現
// 或消失，矩陣仍全綠、測試偵測不到——修正後見下方 S3 區塊）。
//
// 與 tests/telescope.test.ts「S1-S7 warning 矩陣」（Task 4，F5+F6-B 專屬測試的副產品）
// 的關係：本檔是 controller 指定的正式落地位置（spec 原文明點 param-sweep 機制）。下面
// 每組期望值都是逐組獨立重推（不是照抄 Task 4 的期望值）——推導過程見各組註解，使用的
// 公式常數（NOTCH_CENTER_RATIO=29.3385/179、A_CHAIN_REACH_LONGWALL=21.5018、
// B_TONGUE_RESERVED_LONGWALL=9.398、B_TONGUE_END_LONGWALL/SHORTWALL=45/35、
// V_RELIEF_INSET=2.5、V_RELIEF_MIN_END=7.5、PLATFORM_CORNER_MIN_WIDTH=2.5）取自
// tray.ts／index.ts 既有私有常數（同 index.ts 自己的獨立重算慣例，這些常數本身就是 T0
// 量測／spec 公式的具體實例化，不是「code 的意見」）。結論：7 組全部與 spec §驗收 4
// 表一致，且與 Task 4 的既有測試一致——沒有發現不一致，因此沒有需要回報 controller 的落差
// （若曾發現落差，會在這裡改成註記＋不改 expected，而不是靜默調整）。
//
// gusset-relief-omitted 的特殊性（誠實記錄）：這一個 id 的可容納判定（tray.ts
// aGussetChainFits）分兩層——①b 軸（壁界／notch 衝突，reachZoneStart=wallSpan/2−
// A_CHAIN_REACH_LONGWALL，加上 notch 開口不得落進鏈區）是封閉公式，可手推；②a 軸（鏈
// 自身錨點校正後是否自撞，hasSelfIntersection）沒有封閉公式（spec 原文也只說「鏈自身在
// 該盒高下不扭曲自交」，未給不等式）——這部分的「推導」只能是實際跑 telescope.generate()
// 直接讀結果（與 tray.ts 的 anyGussetChainOmitted 自己承認的作法一致，見 index.ts 該函式
// docblock：「改為直接讀生成結果，保證這條 invariant 與 tray.ts 的實際輸出恆一致」）。
// 下面每組會註明「b 軸」「a 軸」兩層各自的判定方式，凡屬 a 軸的結論都明講「已用
// telescope.generate() 實跑驗證，非手算」，不偽裝成純公式推導。
//
// 「其餘取 production-P 值」（spec §驗收 4 表頭）：本檔嚴格採用完整 PRODUCTION_P fixture
// 物件展開＋覆寫，不是只設被 override 的幾個 key、其餘落回 schema 預設（Task 4 的
// warningSet() 用的是後者）。兩者對這 7 個 warning id 的判定結果經 telescope.generate()
// 實跑交叉驗證完全一致（thickness 只進 B 款角撐 minStyleBHeight／A 款 reach 讀的是
// wallTopCompensation 不是 thickness，兩者都與這 7 個 id 的判定公式無關；linerEnabled
// 只影響 liner 自己的幾何，不影響這 7 個 id）——但完整 P fixture 展開讓「全組：無 crash」
// 那條測試更乾淨：linerEnabled 用 P 的 false，S3（baseWidth=30）才不會額外多觸發一個
// 不相關的 liner-flap-fits（linerEnabled=true 時 baseWidth=30 也會頂到內襯翼片外緣反轉
// 門檻，是內襯自己的獨立退化，混進來會讓「既有 invariant 例外清單」多一項不必要的雜訊）。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope（天地盒）：縮放降級矩陣 S1-S7（spec §驗收 4，Slice 5 Task 5）', () => {
  /** spec §production-P fixture（spec 原文 JSON 逐字）——S1-S7 每組「其餘」欄位的基準值。 */
  const PRODUCTION_P: Overrides = {
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

  /**
   * production-P 疊加 override，跑 telescope.generate()，回傳 telescope.invariants 全部
   * （16 條）中實際觸發（check().ok===false）的 id 完整集合——不篩子集（2026-07-11 SOL
   * review M1 修正：舊版用一個寫死的 7-id DEGRADATION_IDS 白名單篩選，把既有 module
   * invariant（tongue-flap-fits／gusset-b-fits／liner-flap-fits／rim-flush／
   * pieces-identity 等）排除在集合外——但 spec §驗收 4 表 S3 明列「＋既有
   * tongue-flap-fits（如觸發）」，可見既有 invariant 觸發與否本就是預期集合的一部分，
   * 舊篩選下這條既有 warning 意外出現或消失，矩陣仍全綠、測試偵測不到。見下方檔頭註解）。
   */
  function degradationWarningSet(overrides: Overrides): { params: ResolvedParams; result: GenerateResult; fired: Set<string> } {
    const params = resolveParams(telescope, { ...PRODUCTION_P, ...overrides });
    const result = telescope.generate(params);
    const fired = new Set<string>();
    for (const inv of telescope.invariants) {
      if (!inv.check(params, result).ok) fired.add(inv.id);
    }
    return { params, result, fired };
  }

  /** 單組 S 案例：warning unique-id 集合精確匹配 expected（推導見呼叫端上方註解）。 */
  function assertDegradationMatrix(label: string, overrides: Overrides, expected: Set<string>): void {
    it(`${label}：warning 集合＝${expected.size === 0 ? '∅' : JSON.stringify([...expected])}`, () => {
      const { fired } = degradationWarningSet(overrides);
      expect(fired, label).toEqual(expected);
    });
  }

  // S1（production-P 原組，overrides=∅）：
  // - notch（base，A 款，basePlatformWidth=5>0）：長壁（側壁）span=baseLength=179 恰為
  //   T0 校準值本身，NOTCH_CENTER_RATIO×179=29.3385（定義上就是這個比例的來源）——
  //   2×29.3385−30=28.677≥5 且 29.3385+15=44.3385≤89.5，兩 notch 皆放得下。短壁
  //   span=baseWidth=124≥40，短壁單 notch 亦可容納，因此不觸發 notch-omitted（L2 review
  //   fix，2026-07-11：長短壁 notch 各自獨立生成，不是「長壁放下後短壁便不需要」——即使
  //   長壁兩個都放不下，短壁的單一置中判定依然是各自獨立成立，見 anyNotchDegradation
  //   對 longSpan/shortSpan 的兩次獨立呼叫）。
  //   → notch-reduced／notch-omitted 皆不觸發。
  // - platform-corner-omitted：basePlatformWidth=5≥2.5、lidPlatformWidth=0（不>0，不參與判定）→ 不觸發。
  // - gusset-relief-omitted（base，A 款）b 軸：reachZoneStart=179/2−21.5018=67.9982，
  //   notch 中心±29.3385＋半開口15=44.3385≤67.9982→b 軸不衝突。a 軸：production-P 本身
  //   就是 T0 校準點（height−wallTopCompensation=59.5），鏈的錨點校正在此點理論上不應
  //   自撞——已用 telescope.generate() 實跑確認：不觸發。
  // - B 款舌根（lid，B 款，lidPlatformWidth=0）：lidPanelY=179+2×18.5=216（長壁/左右壁），
  //   reservedSpan=2×(216/2−9.398)=197.204≥2×45+10=100→分支 1（不縮，端段=45，無警告）；
  //   lidPanelX=124+2×13.5=151（短壁/前後壁），reservedSpan=2×(151/2−2.5)=146≥2×35+10=80
  //   →分支 1（端段=35，無警告）；V relief E′=35≥7.5，不省略。
  //   （交叉核對：與 spec §T0/§F5 原文引用的「197.2」「146」「107.2」「76」等數字一致；
  //   與 tests/telescope.test.ts S1-S7 warning 矩陣 Task 4 測試結論一致。）
  // → S1 預期：∅。
  assertDegradationMatrix('S1（production-P 原組）', {}, new Set());

  // S2（baseLength=60, baseWidth=40）：
  // - notch（base，A 款）：長壁 span=60，中心=NOTCH_CENTER_RATIO×60=9.8341，
  //   2×9.8341−30=−10.33<5→兩個放不下；60≥40（開口30+2×安全邊5）→降級為單一置中
  //   （notch-reduced，非 notch-omitted）。短壁 span=40，40≥40→單一 notch 仍放得下（不觸發）。
  // - gusset-relief-omitted（base）b 軸：reachZoneStart=60/2−21.5018=8.4982；notch 降級後
  //   中心=[0]，半開口15>8.4982→notch 已落進鏈區，b 軸衝突→整鏈省略（不需要再看 a 軸，
  //   b 軸任一層失敗即整鏈省略）。已用 telescope.generate() 實跑確認觸發。
  // - B 款舌根（lid）：lidPanelY=60+37=97（長壁），reservedSpan=2×(97/2−9.398)=78.204，
  //   10≤78.204<100→分支 2（tongue-crease-shrunk，端段縮至 (78.204−10)/2=34.102）；
  //   lidPanelX=40+27=67（短壁），reservedSpan=2×(67/2−2.5)=62，10≤62<80→分支 2 同 id
  //   （端段縮至 (62−10)/2=26）。E′=26≥7.5，relief-omitted 不觸發；78.204／62 皆≥10，
  //   tongue-crease-omitted 不觸發。
  // - platform-corner-omitted：basePlatformWidth/lidPlatformWidth 未變（5/0）→不觸發。
  // → S2 預期：{notch-reduced, tongue-crease-shrunk, gusset-relief-omitted}
  //   （交叉核對：與 tests/telescope.test.ts 對應 S2 測試逐字一致的中間值 78.204/62/26）。
  assertDegradationMatrix('S2（baseLength=60, baseWidth=40）', { baseLength: 60, baseWidth: 40 }, new Set(['notch-reduced', 'tongue-crease-shrunk', 'gusset-relief-omitted']));

  // S3（baseLength=40, baseWidth=30）：
  // - notch（base，A 款）：長壁 span=40，中心=NOTCH_CENTER_RATIO×40=6.5561，
  //   2×6.5561−30=−16.89<5→兩個放不下；40≥40（恰為門檻，非嚴格小於）→降級為單一置中
  //   （notch-reduced）。短壁 span=30<40→單一都放不下，全省（notch-omitted）。兩者同時觸發。
  // - gusset-relief-omitted（base）b 軸：reachZoneStart=40/2−21.5018=−1.5018<0→壁本身已
  //   窄於鏈的固定佔用量，無條件整鏈省略（不需要看 notch 或 a 軸）。已用
  //   telescope.generate() 實跑確認觸發。
  // - B 款舌根（lid）：lidPanelY=40+37=77（長壁），reservedSpan=2×(77/2−9.398)=58.204，
  //   10≤58.204<100→分支 2（tongue-crease-shrunk，端段縮至 24.102）；lidPanelX=30+27=57
  //   （短壁），reservedSpan=2×(57/2−2.5)=52，10≤52<80→分支 2 同 id（端段縮至 21）。
  //   E′=21≥7.5，relief-omitted 不觸發。
  // - platform-corner-omitted：未變（5/0）→不觸發。
  // - tongue-flap-fits（既有 module invariant，2026-07-11 SOL review M1 修正新增）：base
  //   前後壁 baseWidth=30mm，門檻 edge/2<MIN_TONGUE_PERP_HALF(16.5)——30/2=15<16.5，插底
  //   舌讓位所需最小邊長 33mm 未達，梯形已反轉自撞，check() 回 not-ok。這是 F4/F5 之前就
  //   存在、與本 task 無關的獨立參數域邊界退化，但 spec §驗收 4 表 S3 行明列「＋既有
  //   tongue-flap-fits（如觸發）」——完整集合比較下（見上方 degradationWarningSet 檔頭
  //   註解），既有 module invariant 觸發與否本就是預期集合的一部分，必須納入，不能因為
  //   它「既有」就篩掉。已用 telescope.generate() 實跑確認觸發（與 SOL 實跑結果一致）。
  // → S3 預期：{notch-reduced, notch-omitted, tongue-crease-shrunk, gusset-relief-omitted,
  //   tongue-flap-fits}（無 relief-omitted——spec 表註記「E′ 仍≥7.5」，與這裡算出的 21
  //   一致；tongue-flap-fits 為 spec 表 S3 行的「＋既有」條目，五項對齊 spec 原文）。
  assertDegradationMatrix(
    'S3（baseLength=40, baseWidth=30）',
    { baseLength: 40, baseWidth: 30 },
    new Set(['notch-reduced', 'notch-omitted', 'tongue-crease-shrunk', 'gusset-relief-omitted', 'tongue-flap-fits']),
  );

  // S4（basePlatformWidth=2，其餘含 baseLength/baseWidth=179/124 nominal）：
  // - platform-corner-omitted：basePlatformWidth=2，2>0 且 2<2.5（PLATFORM_CORNER_MIN_WIDTH）
  //   →降級為直角，觸發。lidPlatformWidth=0（不>0）→不參與。
  // - notch（base，A 款，basePlatformWidth=2 仍>0，仍走 A 款判準）：baseLength/baseWidth
  //   未變（179/124），notch 中心公式只吃 wallSpan，不吃 platformWidth→與 S1 相同結果，
  //   不觸發。
  // - gusset-relief-omitted（base）b 軸：wallSpan=baseLength=179 未變，reachZoneStart=
  //   67.9982、notch 中心 44.3385≤67.9982，與 S1 相同，b 軸不衝突。a 軸：這裡是本組唯一
  //   無法只憑 b 軸公式排除的部分——longAnchors 的 distPlatformEnd/distTongueApproach/
  //   distTongueFold 三個錨點都內含 `+platformWidth` 項（見 tray.ts generateTray 的
  //   longAnchors 推導），platformWidth 5→2 讓這三個錨點少 3mm，鏈的錨點校正
  //   （snapALongAnchor）餵進 aGussetChainSelfIntersects 的輸入因此與 S1 不同，是否仍不
  //   自撞不能只憑「b 軸未變」類推——已用 telescope.generate() 實跑確認：不觸發
  //   （3mm 的錨點平移不足以讓鏈自撞）。
  // - B 款舌根（lid）：lidPlatformWidth/baseLength/baseWidth 皆未變→與 S1 相同，不觸發。
  // → S4 預期：{platform-corner-omitted}
  assertDegradationMatrix('S4（basePlatformWidth=2）', { basePlatformWidth: 2 }, new Set(['platform-corner-omitted']));

  // S5（rootJog=innerWallReduction=wallTopCompensation=thickness=0，t=0 等價形態）：
  // - baseLength/baseWidth/lidMargin*/platformWidth* 皆未變（179/124/13.5/18.5/5/0）→
  //   notch／platform-corner／B 款舌根三組的判定只吃這些 span/platformWidth 輸入，與 S1
  //   完全相同的公式輸入→不觸發（notch-reduced/omitted、platform-corner-omitted、
  //   tongue-crease-shrunk/omitted、relief-omitted 全部沿用 S1 的∅結論）。
  // - gusset-relief-omitted（base）b 軸：wallSpan/notch 中心與 S1 完全相同（這三個歸零
  //   參數都不進 b 軸公式）→不衝突。a 軸：這裡也不能只憑 b 軸類推——longAnchors 的
  //   distOuter=height−wallTopCompensation 從 59.5 變 60（+0.5mm），
  //   distTongueApproach/distTongueFold 內的 innerWallReduction 項從 0.8 變 0（相對位移
  //   −0.8mm）——兩個小位移是否仍不自撞已用 telescope.generate() 實跑確認：不觸發
  //   （與 F3「t=0 且三補償全 0」等價形態裁決一致：合法參數形狀，非邊界穿越）。
  // → S5 預期：∅（與 spec F3 t=0 裁決一致）。
  assertDegradationMatrix('S5（rootJog=innerWallReduction=wallTopCompensation=thickness=0）', { rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0, thickness: 0 }, new Set());

  // S6（lidMarginX=5, lidMarginY=60，極端不對稱）：
  // - base 完全未變（baseLength/baseWidth/basePlatformWidth/wallTopCompensation/
  //   innerWallReduction 皆 production-P 值）→ base 的 notch／gusset-relief-omitted 兩組
  //   （b 軸與 a 軸皆吃不到 lidMargin*）與 S1 逐位元相同→不觸發（a 軸這裡可以放心類推，
  //   因為 base 的 longAnchors 輸入完全沒變，不像 S4/S5 那樣有位移）。
  // - B 款舌根（lid，lidPlatformWidth 未變＝0）：lidPanelY=179+2×60=299（長壁），
  //   reservedSpan=2×(299/2−9.398)=280.204≥100→分支 1（不縮）；lidPanelX=124+2×5=134
  //   （短壁），reservedSpan=2×(134/2−2.5)=129≥80→分支 1（不縮，端段=35≥7.5，V relief
  //   保留）。兩軸雖然極端不對稱（lidMarginX 取 min、lidMarginY 取 max），但都遠離各自
  //   的降級門檻（280.204≫100、129≫80）→ 全部不觸發。
  // - platform-corner-omitted：platformWidth* 未變→不觸發。
  // → S6 預期：∅（spec 表註記「極端不對稱但全細節仍可容納」，與此處算出的餘裕量一致）。
  assertDegradationMatrix('S6（lidMarginX=5, lidMarginY=60）', { lidMarginX: 5, lidMarginY: 60 }, new Set());

  // S7（basePlatformWidth=0, lidPlatformWidth=5，A/B 款式互換）：
  // - notch（now 換成 lid，A 款，height=lidHeight=45）：wallSpan=lidPanelY=216（未變，
  //   baseLength/lidMarginY 都未變）、中心=NOTCH_CENTER_RATIO×216=35.4029，
  //   2×35.4029−30=40.8058≥5 且 35.4029+15=50.4029≤108，兩 notch 放得下→不觸發。短壁
  //   span=lidPanelX=151≥40→短壁單 notch 亦可容納，因此不觸發 notch-omitted（L2 review
  //   fix，2026-07-11：長短壁 notch 各自獨立生成，不是「長壁放下後短壁便不需要」，同上方
  //   S1 區塊註解）。
  // - platform-corner-omitted：lidPlatformWidth=5≥2.5、basePlatformWidth=0（不>0，不參與）
  //   →不觸發。
  // - B 款舌根（now 換成 base，B 款）：baseLength=179（長壁本身，非 lid 疊加），
  //   reservedSpan=2×(179/2−9.398)=160.204≥100→分支 1（端段=45，不縮）；baseWidth=124
  //   （短壁），reservedSpan=2×(124/2−2.5)=119≥80→分支 1（端段=35，不縮，V relief 保留，
  //   E′=35≥7.5）。**兩軸皆落分支 1**——與 spec §驗收 4 表 S7 列的結構斷言原文「下盒得
  //   B 款舌根拓撲（crease 端段＋V relief，三分支落分支 1）」逐字對應。
  // - gusset-relief-omitted（now 換成 lid，A 款，height=45，wallTopCompensation 對 lid
  //   恆寫死 0，見 index.ts buildLidPiece）b 軸：reachZoneStart=216/2−21.5018=86.4982，
  //   notch 中心 35.4029+15=50.4029≤86.4982→b 軸完全不衝突（可用公式排除，不是模糊地帶）。
  //   a 軸：b 軸已排除，所以若觸發，原因必然是 a 軸自撞——longAnchors.distOuter=
  //   height−wallTopCompensation=45−0=45，遠低於鏈模板校準時的 base 典型值（~59.5-60），
  //   錨點校正後鏈的內部相對關係已偏離 T0 設計太遠。這部分無封閉公式，已用
  //   telescope.generate() 實跑確認：觸發（v1.5 T4 實測更正的同一組，本次重新獨立驗證
  //   仍然成立——T4 之後的三個 review fix commit(b839615/f05e6db/b5e904b) 未改變此結論）。
  // → S7 預期：{gusset-relief-omitted}（v1.5 T4 實測更正值，非 v1.4 原始∅）。
  assertDegradationMatrix('S7（basePlatformWidth=0, lidPlatformWidth=5，款式互換）', { basePlatformWidth: 0, lidPlatformWidth: 5 }, new Set(['gusset-relief-omitted']));

  it('全組（S1-S7）：generate 不 throw、無 NaN、bounds 有限、全部既有 module invariant.check() 不 throw', () => {
    const cases: Array<[string, Overrides]> = [
      ['S1', {}],
      ['S2', { baseLength: 60, baseWidth: 40 }],
      ['S3', { baseLength: 40, baseWidth: 30 }],
      ['S4', { basePlatformWidth: 2 }],
      ['S5', { rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0, thickness: 0 }],
      ['S6', { lidMarginX: 5, lidMarginY: 60 }],
      ['S7', { basePlatformWidth: 0, lidPlatformWidth: 5 }],
    ];

    for (const [label, overrides] of cases) {
      let params: ResolvedParams | undefined;
      let result: GenerateResult | undefined;
      expect(() => {
        params = resolveParams(telescope, { ...PRODUCTION_P, ...overrides });
        result = telescope.generate(params);
      }, label).not.toThrow();

      const segs = result!.paths.flatMap((p) => p.segments);
      expect(hasNaN(segs), `${label}：不應含 NaN 座標`).toBe(false);
      for (const [key, v] of Object.entries(result!.bounds)) {
        expect(Number.isFinite(v), `${label}：bounds.${key} 應為有限值，實際為 ${v}`).toBe(true);
      }

      // 全部 16 條 invariant（含 7 個細節降級 id＋既有 module invariant，例如 S3 會
      // not-ok 的 tongue-flap-fits，見上方 S3 註解）這裡只要求「不 throw」，不要求
      // ok:true——ok:true／not-ok 的精確狀態由上面 assertDegradationMatrix 的完整
      // fired-set 比對釘住（2026-07-11 SOL review M1 修正：assertDegradationMatrix 不再
      // 局限於 7 個 degradation id，而是覆蓋這裡同一份 telescope.invariants 全集；此處與
      // assertDegradationMatrix 是「不 throw」與「ok 狀態精確比對」兩層不同粒度的斷言，
      // 不是兩個互斥的 id 範疇）。
      for (const inv of telescope.invariants) {
        expect(() => inv.check(params!, result!), `${label} / ${inv.id} 不應 throw`).not.toThrow();
      }
    }
  });
});

describe('invariant 英文訊息不洩漏 CJK 文案', () => {
  function extremeOverrides(box: BoxModule, bound: 'min' | 'max'): Overrides {
    return Object.fromEntries(
      box.params.flatMap((param) => {
        if (param.unit !== 'mm' && param.unit !== 'deg') return [];
        const value = param[bound];
        return value === undefined ? [] : [[param.key, value]];
      }),
    );
  }

  const cases: Array<[string, BoxModule, Overrides]> = [
    ['RTE narrow-panel/max-lock', reverseTuckEnd, { ...extremeOverrides(reverseTuckEnd, 'min'), tuckLock: 60 }],
    ['RTE wide-panel/min-positive-lock', reverseTuckEnd, { ...extremeOverrides(reverseTuckEnd, 'max'), tuckLock: 1 }],
    ['telescope all-min', telescope, extremeOverrides(telescope, 'min')],
    ['telescope all-max', telescope, extremeOverrides(telescope, 'max')],
  ];

  for (const [label, box, overrides] of cases) {
    it(`${label}：退化參數域產生的所有 invariant en message 均不含 CJK`, () => {
      const params = resolveParams(box, overrides);
      const result = box.generate(params);
      const warnings = box.invariants
        .map((invariant) => ({ id: invariant.id, outcome: invariant.check(params, result) }))
        .filter((entry) => !entry.outcome.ok);

      expect(warnings.length, `${label} 應至少觸發一條 invariant，避免空集合假綠`).toBeGreaterThan(0);
      for (const { id, outcome } of warnings) {
        if (!outcome.ok) {
          expect(outcome.message.en, `${label} / ${id}`).not.toMatch(/[一-鿿]/u);
        }
      }
    });
  }
});
