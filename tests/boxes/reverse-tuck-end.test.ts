import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { normalizeSegments, hasNaN, segmentsBounds } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import { resolveParams, getBox } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import referenceRaw from '../fixtures/rte-reference.json';

// ── 前身 d 字串 → Segment 的測試專用 parser（brief 指示可 import PathBuilder 來 parse，不重寫幾何）──
//
// 注意：brief 原文說「前身 d 只含 M/L/A 這三種指令」，但實測 fixture 發現不是這樣——
// P2-top／P4-top／P2-bottom 三處 drawRelief（J-Hook 避讓槽）的 d 字串另外用了 `C`
// （三次貝茲，對應 reliefSlot 的 bezierTo）。這是 brief 描述的失準，不是 fixture 的錯；
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
      // A rx ry rot largeArc sweep x,y —— 前身固定 rx=ry=r、rot=0、largeArc=0（brief 明列）
      builder.arcTo(args[0]!, args[4] as 0 | 1, args[5]!, args[6]!);
    } else {
      // C c1x c1y, c2x c2y, x y（reliefSlot 貝茲；見上方檔頭註解）
      builder.bezierTo(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!);
    }
  }
  return builder.segments();
}

type ReferenceFixture = { paths: { type: string; d: string }[] };

/** 等價比對排除 dimension 線（前身標註線含文字定位微差可接受；主幾何 cut/crease 必須全等）。 */
function parseReferenceDStrings(raw: ReferenceFixture): Segment[] {
  return raw.paths.filter((p) => p.type !== 'dimension').flatMap((p) => parseDToSegments(p.d));
}

/** 預設參數上疊 overrides 後直接 generate 的捷徑。 */
const gen = (overrides?: Partial<Record<string, number | boolean | string>>) =>
  reverseTuckEnd.generate(resolveParams(reverseTuckEnd, overrides));

describe('reverseTuckEnd', () => {
  it('模組載入時已透過 registerBox 自行註冊（id=rte）', () => {
    expect(getBox('rte')).toBe(reverseTuckEnd);
  });

  it('等價驗證：與前身輸出在 normalized Segment 層一致（spec §4.1）', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const ours = normalizeSegments(result.paths.filter((p) => p.type !== 'dimension').flatMap((p) => p.segments));
    const reference = normalizeSegments(parseReferenceDStrings(referenceRaw));
    expect(ours).toEqual(reference);
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
    const params = resolveParams(reverseTuckEnd, { glueSide: 'right' });
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
});
