import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { normalizeSegments, hasNaN, segmentsBounds } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import { resolveParams, getBox } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import type { GenerateResult } from '@/core/types';
import referenceRaw from '../fixtures/rte-reference.json';

// ── 前身 d 字串 → Segment 的測試專用 parser（spec 指示可 import PathBuilder 來 parse，不重寫幾何）──
//
// 注意：spec 原文說「前身 d 只含 M/L/A 這三種指令」，但實測 fixture 發現不是這樣——
// P2-top／P4-top／P2-bottom 三處 drawRelief（J-Hook 避讓槽）的 d 字串另外用了 `C`
// （三次貝茲，對應 reliefSlot 的 bezierTo）。這是 spec 描述的失準，不是 fixture 的錯；
// 已用實際 fixture 資料核實（3 條 cut 型別、tag 'flapNotch' 的路徑含 C 指令），
// 這裡依實測結果補上 C 分支，不能只信 prose 不信資料。
type Cmd = 'M' | 'L' | 'A' | 'C';

function tokenizeD(d: string): { cmd: Cmd; args: number[] }[] {
  const tokens: { cmd: Cmd; args: number[] }[] = [];
  const re = /([MLAC])([^MLAC]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1] as Cmd;
    const args = match[2]!
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    tokens.push({ cmd, args });
  }
  return tokens;
}

/** 單一 d 字串 → Segment[]（一個 PathBuilder 對應一個 addPath 呼叫，如前身逐條獨立路徑）。 */
function parseDToSegments(d: string): Segment[] {
  const builder = new PathBuilder();
  for (const { cmd, args } of tokenizeD(d)) {
    if (cmd === 'M') {
      builder.moveTo(args[0]!, args[1]!);
    } else if (cmd === 'L') {
      builder.lineTo(args[0]!, args[1]!);
    } else if (cmd === 'A') {
      // A rx ry rot largeArc sweep x,y —— 前身固定 rx=ry=r、rot=0、largeArc=0（spec 明列）。
      // 顯式斷言這個假設而非靜默忽略欄位：若未來新盒型的參照 fixture 含橢圓弧（rx≠ry）、
      // 旋轉（rot≠0）或大弧（largeArc=1），parser 應該立刻報錯，而不是安靜地丟掉這些欄位、
      // 產生一個「看起來解析成功、實際上幾何解錯」的假陽性（Fix Round 1 #4）。
      const rx = args[0]!;
      const ry = args[1]!;
      const rot = args[2]!;
      const largeArc = args[3]!;
      const sweep = args[4]! as 0 | 1;
      const x = args[5]!;
      const y = args[6]!;
      if (!(rx === ry && rot === 0 && largeArc === 0)) {
        throw new Error(
          `parseDToSegments: 不支援的 SVG A 指令參數（rx=${rx}, ry=${ry}, rotation=${rot}, largeArc=${largeArc}）—— ` +
            `parser 假設 rx===ry 且 rotation===0 且 largeArc===0（前身固定寫死這三項），遇到不同組合代表` +
            `參照資料含橢圓弧/旋轉/大弧，需要先擴充 parser 才能正確解析，不可靜默誤解。`,
        );
      }
      builder.arcTo(rx, sweep, x, y);
    } else {
      // C c1x c1y, c2x c2y, x y（reliefSlot 貝茲；見上方檔頭註解）
      builder.bezierTo(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!);
    }
  }
  return builder.segments();
}

type ReferenceFixture = { paths: { type: string; d: string }[] };

/**
 * 依線型分組取出 reference 的 Segment（Fix Round 1 #1：cut 與 crease 分開比對，不得攤平混記）。
 *
 * dimension 線永遠被排除在外（前身標註線含文字定位微差可接受；主幾何 cut/crease 必須全等），
 * 只呼叫本函式取 'cut' 或 'crease' 兩種型別，等於天然延續了原本「排除 dimension」的規則。
 */
function parseReferenceSegmentsByType(raw: ReferenceFixture, type: 'cut' | 'crease'): Segment[] {
  return raw.paths.filter((p) => p.type === type).flatMap((p) => parseDToSegments(p.d));
}

/** 預設參數上疊 overrides 後直接 generate 的捷徑。 */
const gen = (overrides?: Partial<Record<string, number | boolean | string>>) =>
  reverseTuckEnd.generate(resolveParams(reverseTuckEnd, overrides));

/**
 * 從 'D' 標籤的縱向分隔線反推 4 個面板寬（girth 補償測試專用）。
 *
 * 見 generate() 的「Main Body Creases」區塊：無論 glueSide 為何，恆有 5 條 'D' 標籤
 * 縱向線標出 x0..x4 五個面板邊界——差別只在 cut/crease 身分互換（glueOnRight 時 x0
 * 是 cut、x4 是 crease；反之亦然），但兩種身分都帶 'D' tag，合併 cut+crease 兩種線型
 * 取 x 座標即可還原完整的 5 點邊界、排序後取相鄰差就是 4 段面板寬，不需要在意
 * 個別是 cut 還是 crease。
 */
function panelWidthsFromBoundaryLines(result: GenerateResult): number[] {
  const xs = result.paths
    .filter((p) => (p.type === 'cut' || p.type === 'crease') && p.tags?.includes('D'))
    .flatMap((p) => p.segments)
    .filter((s): s is Extract<Segment, { kind: 'line' }> => s.kind === 'line')
    .map((s) => s.x1)
    .sort((a, b) => a - b);
  const widths: number[] = [];
  for (let i = 1; i < xs.length; i++) widths.push(xs[i]! - xs[i - 1]!);
  return widths;
}

describe('reverseTuckEnd', () => {
  it('模組載入時已透過 registerBox 自行註冊（id=rte）', () => {
    expect(getBox('rte')).toBe(reverseTuckEnd);
  });

  it('等價驗證：與前身輸出在 normalized Segment 層一致，cut/crease 分線型比對（spec §4.1，Fix Round 1 #1）', () => {
    // 為什麼分組比對比攤平比對嚴格：攤平比對（舊版）把 cut 跟 crease 全部丟進同一個集合
    // 再比對聯集內容，line type 標籤本身完全不影響這個聯集——如果某條線的座標算對了、
    // 但被標成錯的線型（例如該是 cut 卻標成 crease），攤平比對完全看不出來，照樣綠燈。
    // 分組後 cut 跟 crease 各自必須跟 reference 對應分組逐一相等，線型標籤本身變成
    // 比對的一部分：標錯線型會讓其中一組多一條、另一組少一條，兩組都會比對失敗。
    // （已用一次性變造腳本驗證此嚴格性差異，證據見 開發紀錄「Fix Round 1」。）
    // thickness: 0 是 t=0 錨定的核心——fixture 由不吃補償的前身函式產生，只有 t=0 時
    // 我們的補償公式全部歸零、幾何才會與 fixture 逐位元等價（spec Step 1）。
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd, { thickness: 0 }));
    const oursCut = normalizeSegments(result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments));
    const oursCrease = normalizeSegments(result.paths.filter((p) => p.type === 'crease').flatMap((p) => p.segments));
    const referenceCut = normalizeSegments(parseReferenceSegmentsByType(referenceRaw, 'cut'));
    const referenceCrease = normalizeSegments(parseReferenceSegmentsByType(referenceRaw, 'crease'));
    expect(oursCut, 'cut 分組').toEqual(referenceCut);
    expect(oursCrease, 'crease 分組').toEqual(referenceCrease);

    // dimension 分組數量獨立檢查（上面兩個 expect 只驗 cut/crease，契約排除 dimension——
    // 見檔頭註解「dimension 線永遠被排除在外」，dimension 分組本身過去沒有任何斷言）。
    // 這裡數的是攤平後的線段數，不是 result.paths 裡 type==='dimension' 的 DielinePath
    // 物件數：3 次 addDim 呼叫（P2 寬度／P3 長度／盒身高度）各自把 dimensionLine() 產生的
    // 3 條線段（兩條引出線＋一條主標註線）bundle 成 1 個 DielinePath，所以 result.paths
    // 層級只有 3 筆 type=dimension 的物件；攤平 segments 後才是 9 條，與 fixture（前身
    // 逐段展開、一段一個 JSON path 的計數口徑）的 dimension 數一致——見
    // docs/plans/2026-07-07-v1-slice1-core-rte.md:347「前身實測值：cut 19/crease 14/dimension 9」。
    const dimensionSegments = result.paths.filter((p) => p.type === 'dimension').flatMap((p) => p.segments);
    expect(dimensionSegments, 'dimension 分組（flatten 後線段數，fixture 實測值 9）').toHaveLength(9);
  });

  it('parseReferenceSegmentsByType 對 A 指令的 rx/ry/rotation/largeArc 顯式斷言（Fix Round 1 #4）', () => {
    // rx(3) !== ry(5)：前身從未產生過這種橢圓弧，parser 應該直接報錯而不是靜默只取 rx 誤解幾何。
    const malformed: ReferenceFixture = { paths: [{ type: 'cut', d: 'M0,0 A3,5 0 0,1 10,10' }] };
    expect(() => parseReferenceSegmentsByType(malformed, 'cut')).toThrow(/不支援的 SVG A 指令參數/);
  });

  it('假旋鈕：每個參數取第二有效值都改變輸出（spec §8）', () => {
    const base = normalizeSegments(gen({}).paths.flatMap((p) => p.segments));
    for (const p of reverseTuckEnd.params) {
      const alt =
        p.unit === 'bool'
          ? !(p.default as boolean)
          : p.unit === 'enum'
            ? p.options!.find((o) => o.value !== p.default)!.value
            : Math.min(p.max ?? 999, (p.default as number) + Math.max(p.step ?? 1, 1));
      const out = normalizeSegments(gen({ [p.key]: alt }).paths.flatMap((s) => s.segments));
      expect(out, `參數 ${p.key} 未接線`).not.toEqual(base);
    }
  });

  it('全部不變式在預設參數下通過', () => {
    const params = resolveParams(reverseTuckEnd);
    const result = reverseTuckEnd.generate(params);
    for (const inv of reverseTuckEnd.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
  });

  it('golden 快照', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    expect(normalizeSegments(result.paths.flatMap((p) => p.segments))).toMatchSnapshot();
  });

  // ── 補強測試：3 個真實存在、但前 4 組測試都不會觸及的分支 ──
  // （equivalence 只測預設參數；false-knob 每個 param 只挪動一小步，r/tuckLock 都停在
  //  原本的「>0」分支，glueSide 雖然真的切到 'right' 但只斷言「有變化」不驗「變得對不對」）

  it('glueSide=right：糊邊移到最右側，仍通過全部不變式（覆蓋等價測試從未觸及的 glueOnRight 分支）', () => {
    // thickness: 0 是刻意釘住的——這條測試的責任是「glueOnRight 鏡像本身」，跟 girth
    // 補償是兩個獨立關注點；釘 t=0 讓下面這行的手算（x4=220 等）繼續成立，補償與
    // 鏡像的組合改由「girth 補償鏡像」測試（Slice 2）專責涵蓋，見該測試註解。
    const params = resolveParams(reverseTuckEnd, { glueSide: 'right', thickness: 0 });
    const result = reverseTuckEnd.generate(params);
    for (const inv of reverseTuckEnd.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
    // 預設 L=55,W=55,glueSize=12 → x4=220；glueOnRight 時最右緣應延伸到 x4+glueSize=232，最左緣退回 x0=0
    const cutBounds = segmentsBounds(result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments));
    expect(cutBounds.maxX).toBeCloseTo(232, 1);
    expect(cutBounds.minX).toBeCloseTo(0, 1);
  });

  it('tuckRadius=0：插舌兩側尖角改直線（前身另一分支），無 NaN 也不產生 arc 段', () => {
    const params = resolveParams(reverseTuckEnd, { tuckRadius: 0 });
    const result = reverseTuckEnd.generate(params);
    const segs = result.paths.flatMap((p) => p.segments);
    expect(hasNaN(segs)).toBe(false);
    expect(segs.some((s) => s.kind === 'arc')).toBe(false);
  });

  it('tuckLock=0：停用摩擦扣，蓋板摺線退化為單一整段 crease、不產生 tuckLock cut', () => {
    const params = resolveParams(reverseTuckEnd, { tuckLock: 0 });
    const result = reverseTuckEnd.generate(params);
    const lockCuts = result.paths.filter((p) => p.type === 'cut' && p.tags?.includes('tuckLock'));
    expect(lockCuts).toHaveLength(0);
  });

  // ── Fix Round 1 #2：tuck-lock-fits 不變式（摩擦扣寬度的幾何自撞檢查）──
  //
  // 上限用 L 而非任務描述例句字面提到的「W」：摩擦扣座落在 perimeter() 的
  // lid.start~lid.end 這段跨距，top 時＝wP3、bottom 時＝wP1，兩者皆＝L（前身命名裡
  // P1/P3 用 L 當寬度、P2/P4 才用 W；W 決定的是「蓋板高」hLid＝摺線到插舌尖端的垂直
  // 距離，不是蓋板攤平後的水平跨距——兩者是完全不同的兩個量）。
  // 已用 L=40,W=90 的區分性參數實測驗證（見 開發紀錄 Fix Round 1）：tuckLock
  // cut 的 x 範圍精確落在 lid 跨距 [130,170]（寬度=40=L）內，跟 W=90 完全無關；
  // tuckLock=50>40=L 時 cut 範圍變成 [125,175]，確實切出 lid 跨距外。故採用 L。
  // 預設參數下本不變式為 ok，已由上面「全部不變式在預設參數下通過」涵蓋，不重複斷言。

  it('tuck-lock-fits：tuckLock 超過蓋板可容納寬度 L 時判定不通過（T9 極端參數驗收場景）', () => {
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'tuck-lock-fits')!;
    expect(inv, '不變式 tuck-lock-fits 應已存在').toBeDefined();
    const params = resolveParams(reverseTuckEnd, { L: 20, tuckLock: 60 });
    const result = reverseTuckEnd.generate(params);
    const check = inv.check(params, result);
    expect(check.ok, 'tuckLock(60) > L(20) 應觸發警告').toBe(false);
  });

  it('tuck-lock-fits：tuckLock 小於兩側導角總和（2×LOCK_CHAMFER=4mm）時判定不通過（梯形反折）', () => {
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'tuck-lock-fits')!;
    expect(inv, '不變式 tuck-lock-fits 應已存在').toBeDefined();
    const params = resolveParams(reverseTuckEnd, { tuckLock: 2 });
    const result = reverseTuckEnd.generate(params);
    const check = inv.check(params, result);
    expect(check.ok, 'tuckLock(2) < 4mm 應觸發反折警告').toBe(false);
  });

  // ── Fix Round 1 #3：lid-equals-w 不變式強化（數量 ≥4，防「少畫一側蓋板仍通過」）──
  //
  // 數的是哪四條：上蓋（perimeter('top')）跟下蓋（perimeter('bottom')）各自的
  // lid.start／lid.end 兩條鉛直側邊 cut（tag='W'），共 2+2=4 條；用「鉛直線（x1≈x2）
  // 且長度≈W」這組位置特徵鎖定，不是只看長度——避免任何巧合等長但方向不對的線段被誤數，
  // 也讓「只剩幾條」這種缺漏能被數量門檻抓到（舊版 .some() 只要 1 條符合就整體判定通過）。

  it('lid-equals-w：只剩 2 條蓋板側邊 cut（模擬漏畫一側蓋板）應判定不通過', () => {
    const params = resolveParams(reverseTuckEnd);
    const w = params.W as number;
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'lid-equals-w')!;
    // 只放「下蓋」那 2 條、模擬「上蓋整個沒畫出來」的 bug——舊版 invariant 用 .some()
    // 只要找到 1 條長度符合就過，這裡故意只留 2 條讓新版「數量 ≥4」的門檻失敗。
    const fakeResult: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', tags: ['W'], segments: [{ kind: 'line', x1: 0, y1: 117, x2: 0, y2: 117 + w }] },
        { id: 'p-1', type: 'cut', tags: ['W'], segments: [{ kind: 'line', x1: 55, y1: 117, x2: 55, y2: 117 + w }] },
      ],
      texts: [],
      bounds: { minX: -20, maxX: 300, minY: -100, maxY: 300 },
    };
    const check = inv.check(params, fakeResult);
    expect(check.ok, '只有 2 條蓋板側邊 cut 時應判定不通過').toBe(false);
  });

  // ── T9 Fix Round 2 修復 1：插舌圓角鉗制（tuckRadius > tuckDepth 時垂直邊翻折伸出）──
  //
  // 根因（已對照前身 ReverseTuckEnd.ts 逐行核對，等價移植的既有 bug）：插舌輪廓的垂直邊
  // 畫到 `yTuck - ySign*r`（前身寫死 `y_tuck ± r`）。當 r（tuckRadius）大於 hTuck（tuckDepth）
  // 時，這個點會越過摺線 yFold 翻到另一側，垂直邊反向翻出、圓弧從錯位點畫回，圖形自撞。
  // 修法：generate() 內鉗制 `effectiveR = min(tuckRadius, tuckDepth, 插舌半寬)`，圓弧與頂邊
  // 全部改用 effectiveR；並加不變式 tuck-radius-clamped 示警「設定值未如實生效」。

  it('修復 1：tuckRadius=14 > tuckDepth=10 時，插舌 cut path 的 y 範圍應鉗制在 [yFold,yTuck] 合法區間內（不翻折出界）', () => {
    const params = resolveParams(reverseTuckEnd, { tuckRadius: 14, tuckDepth: 10 });
    const result = reverseTuckEnd.generate(params);
    const w = params.W as number;
    const d = params.D as number;
    const hLid = w;
    const hTuck = params.tuckDepth as number;

    const tuckPaths = result.paths.filter((p) => p.type === 'cut' && p.tags?.includes('tuckDepth'));
    expect(tuckPaths, '應有上蓋／下蓋各一條插舌 cut path').toHaveLength(2);

    for (const path of tuckPaths) {
      const bounds = segmentsBounds(path.segments);
      const isTop = bounds.maxY <= 0; // top 插舌全在 y<=0；bottom 插舌全在 y>=D
      const legalMin = isTop ? -hLid - hTuck : d + hLid;
      const legalMax = isTop ? -hLid : d + hLid + hTuck;
      expect(bounds.minY, `${isTop ? 'top' : 'bottom'} 插舌 minY 不得超出合法區間`).toBeGreaterThanOrEqual(
        legalMin - 0.01,
      );
      expect(bounds.maxY, `${isTop ? 'top' : 'bottom'} 插舌 maxY 不得超出合法區間`).toBeLessThanOrEqual(
        legalMax + 0.01,
      );
    }
  });

  it('修復 1：tuckRadius=14 > tuckDepth=10 時 tuck-radius-clamped 不變式回報 not-ok（示警設定值未如實生效）', () => {
    const params = resolveParams(reverseTuckEnd, { tuckRadius: 14, tuckDepth: 10 });
    const result = reverseTuckEnd.generate(params);
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'tuck-radius-clamped')!;
    expect(inv, '不變式 tuck-radius-clamped 應已存在').toBeDefined();
    const check = inv.check(params, result);
    expect(check.ok, 'tuckRadius(14) > 幾何上限(=tuckDepth=10) 應觸發警告').toBe(false);
    if (!check.ok) {
      expect(check.tags).toEqual(expect.arrayContaining(['tuckRadius', 'tuckDepth']));
    }
  });

  it('修復 1：預設參數（tuckRadius=3）不觸發鉗制，effectiveR=r，幾何與鉗制前完全一致', () => {
    // 這條測試存在的意義：證明鉗制邏輯只在超界時改變行為，預設路徑（含等價測試與 golden
    // 快照所依賴的預設參數）完全不受影響——鉗制前後 normalizeSegments 輸出必須逐位元相同。
    const params = resolveParams(reverseTuckEnd);
    const result = reverseTuckEnd.generate(params);
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'tuck-radius-clamped')!;
    expect(inv.check(params, result)).toMatchObject({ ok: true });
  });

  it('lid-equals-w：4 條長度巧合＝W 但方向是斜線（非鉛直）的 cut 不應算數（位置特徵而非只看長度）', () => {
    const params = resolveParams(reverseTuckEnd);
    const w = params.W as number; // 預設 55 → 3-4-5 直角三角形縮放 11 倍：33-44-55，斜邊長度剛好＝W
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'lid-equals-w')!;
    const diagonal = (x: number, y: number): Segment => ({ kind: 'line', x1: x, y1: y, x2: x + 33, y2: y + 44 });
    const fakeResult: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', tags: ['W'], segments: [diagonal(0, 0)] },
        { id: 'p-1', type: 'cut', tags: ['W'], segments: [diagonal(55, 0)] },
        { id: 'p-2', type: 'cut', tags: ['W'], segments: [diagonal(0, 117)] },
        { id: 'p-3', type: 'cut', tags: ['W'], segments: [diagonal(55, 117)] },
      ],
      texts: [],
      bounds: { minX: -20, maxX: 300, minY: -100, maxY: 300 },
    };
    expect(w).toBeCloseTo(55, 5);
    const check = inv.check(params, fakeResult);
    expect(check.ok, '4 條斜線即使長度都＝W 也不該被算成蓋板側邊 cut').toBe(false);
  });

  // ── T9 Fix Round 2 修復 2A：no-cut-self-intersection 不變式 ──
  // 預設參數下的 ok 已由「全部不變式在預設參數下通過」涵蓋（false positive 檢查一次到位，
  // 過程與結論記於 開發紀錄），這裡只補「已知自撞案例應 not-ok」。

  it('no-cut-self-intersection：手工造兩條真交叉的 cut 線段，應判定不通過', () => {
    const params = resolveParams(reverseTuckEnd);
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'no-cut-self-intersection')!;
    expect(inv, '不變式 no-cut-self-intersection 應已存在').toBeDefined();
    const fakeResult: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }] },
        { id: 'p-1', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 10, x2: 10, y2: 0 }] }, // 與 p-0 在 (5,5) 真交叉
      ],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const check = inv.check(params, fakeResult);
    expect(check.ok, '兩條真交叉的 cut 線段應觸發自撞警告').toBe(false);
  });

  it('no-cut-self-intersection：cut 線段只是端點相連（正常轉角），不應誤判為自撞', () => {
    const params = resolveParams(reverseTuckEnd);
    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'no-cut-self-intersection')!;
    const fakeResult: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-1', type: 'cut', segments: [{ kind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 }] }, // 端點 (10,0) 共用
      ],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    expect(inv.check(params, fakeResult)).toMatchObject({ ok: true });
  });

  // ── Slice 2（v1.2 spec §4.1）：thickness 標準補償集測試 ──
  //
  // girth／tuckClearance derivedDefault／unfold-width／t 假旋鈕，四項對應 plan Task 2
  // Step 2。上面「glueSide=right」測試（T9 既有）已改釘 thickness:0，讓它繼續只測
  // glueOnRight 鏡像本身；補償與鏡像的組合由這裡的「girth 補償鏡像」測試專責涵蓋。

  it('girth 補償：t=0.4、glueSide=left 時面板寬依序為 [L, W+0.4, L+0.4, W+0.8]（由 D 標籤縱向分隔線的 x 座標反推）', () => {
    const params = resolveParams(reverseTuckEnd, { thickness: 0.4, glueSide: 'left' });
    const result = reverseTuckEnd.generate(params);
    const L = params.L as number;
    const W = params.W as number;
    const widths = panelWidthsFromBoundaryLines(result);
    expect(widths, '5 條邊界線的相鄰差＝4 個面板寬').toHaveLength(4);
    expect(widths[0]!, 'P1 貼糊邊，不補償').toBeCloseTo(L, 5);
    expect(widths[1]!, 'P2 補 +t').toBeCloseTo(W + 0.4, 5);
    expect(widths[2]!, 'P3 補 +t').toBeCloseTo(L + 0.4, 5);
    expect(widths[3]!, 'P4 離糊邊最遠，補 +2t').toBeCloseTo(W + 0.8, 5);
  });

  it('girth 補償鏡像：t=0.4、glueSide=right 時面板寬依序反轉為 [L+0.8, W+0.4, L+0.4, W]', () => {
    const params = resolveParams(reverseTuckEnd, { thickness: 0.4, glueSide: 'right' });
    const result = reverseTuckEnd.generate(params);
    const L = params.L as number;
    const W = params.W as number;
    const widths = panelWidthsFromBoundaryLines(result);
    expect(widths, '5 條邊界線的相鄰差＝4 個面板寬').toHaveLength(4);
    expect(widths[0]!, 'P1 離糊邊最遠（貼 P4 的糊邊在右），補 +2t').toBeCloseTo(L + 0.8, 5);
    expect(widths[1]!, 'P2 補 +t').toBeCloseTo(W + 0.4, 5);
    expect(widths[2]!, 'P3 補 +t').toBeCloseTo(L + 0.4, 5);
    expect(widths[3]!, 'P4 貼糊邊，不補償').toBeCloseTo(W, 5);
  });

  it('tuckClearance derivedDefault：t=0.4 未覆寫時生效值為 0.9（0.5+t）；手動覆寫 2 後維持 2 不被洗掉', () => {
    const derived = resolveParams(reverseTuckEnd, { thickness: 0.4 });
    expect(derived.tuckClearance, '未覆寫時應跟著 thickness 即時重算').toBeCloseTo(0.9, 5);

    const overridden = resolveParams(reverseTuckEnd, { thickness: 0.4, tuckClearance: 2 });
    expect(overridden.tuckClearance, '手動覆寫值優先序高於 derivedDefault，不被洗掉').toBe(2);
  });

  it('unfold-width 補償：t=0.4 時展開總寬＝L+W+L+W+4t+glueSize+40（girth 補償總量與 glueSide 無關，因係數表加總恆為 4）', () => {
    const params = resolveParams(reverseTuckEnd, { thickness: 0.4 });
    const result = reverseTuckEnd.generate(params);
    const L = params.L as number;
    const W = params.W as number;
    const glueSize = params.glueSize as number;
    const t = params.thickness as number;
    const expected = L + W + L + W + 4 * t + glueSize + 40;
    const actual = result.bounds.maxX - result.bounds.minX;
    // 直接量 bounds（不透過 invariant.check）：確保這條測試在補償未接線的中間態必為 RED，
    // 不會因為「不變式公式」跟「測試期望」剛好用同一套舊公式而假綠。
    expect(actual, '展開總寬應反映 girth 補償總量 4t').toBeCloseTo(expected, 2);

    const inv = reverseTuckEnd.invariants.find((i) => i.id === 'unfold-width')!;
    expect(inv.check(params, result), '不變式本身的公式也要同步更新為 +4t').toMatchObject({ ok: true });
  });

  it('t 假旋鈕：thickness=0 與 thickness=0.4 的輸出必不同（自動迴圈已涵蓋此參數，這裡另外釘一條顯式回歸）', () => {
    const zero = normalizeSegments(gen({ thickness: 0 }).paths.flatMap((p) => p.segments));
    const withT = normalizeSegments(gen({ thickness: 0.4 }).paths.flatMap((p) => p.segments));
    expect(withT, 'thickness 從 0 改到 0.4 應改變幾何輸出').not.toEqual(zero);
  });
});
