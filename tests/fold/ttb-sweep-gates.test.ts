// normalized 慣例層：t 取樣密度、容差與走廊寬度依測試契約固定。
// 物理閘門斷言約束本身（紙不穿紙／摺向不反向／角速度上限／掃掠段捲入），
// 不斷言 schedule 時窗數值——時窗可調，違反物理約束才 fail。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { applyTransform, panelWorldTransform, worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';

const STRIP = ['faceA', 'faceB', 'faceC', 'zoneDBase', 'zoneDLip', 'zoneDTab'] as const;
const T_STEPS = 200;
/** slot 走廊：插舌/lip 入槽必經的 faceA 遠端（A/B 稜）鄰域——刀模 slot 位於
 * yAB−0.5、兩側 relief 各 ~0.8mm，走廊取 3mm 覆蓋整組開口。 */
const SLOT_CORRIDOR_MM = 3;
/** 走廊內穿越深度上限：零厚度剛體入槽簽名實測 −3.31mm，容 0.2mm 餘裕。 */
const CORRIDOR_DEPTH_CAP_MM = 3.5;
/** 走廊外允許的最深越面：單幀掠過（實測 −0.35mm）·超過 0.5mm 即視為真穿牆。 */
const STRAY_DEPTH_CAP_MM = 0.5;
/** 角速度上限（deg / 0.01t）：faceB/faceC 自然節奏 ~8°，zoneD 不得超出其 1.1 倍。 */
const RATE_CAP_DEG = 8.8;

interface Span { id: string; y0: number; y1: number; midX: number }

function stripSpans(model: ReturnType<typeof buildTtbFoldModel>): Span[] {
  return STRIP.map((id) => {
    const panel = model.panels.find((candidate) => candidate.id === id)!;
    const ys = panel.polygon.map(({ y }) => y);
    const xs = panel.polygon.map(({ x }) => x);
    return {
      id,
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      midX: (Math.min(...xs) + Math.max(...xs)) / 2,
    };
  });
}

/** 剖面 (y,z) 折線：每片取 (midX, y0)→(midX, y1) 的世界座標投影。 */
function crossSection(
  model: ReturnType<typeof buildTtbFoldModel>,
  spans: Span[],
  t: number,
): [number, number][] {
  const pose = foldPose(t, model);
  return spans.flatMap((span) => {
    const transform = panelWorldTransform(model, pose, span.id);
    const a = applyTransform(transform, { x: span.midX, y: span.y0, z: 0 });
    const b = applyTransform(transform, { x: span.midX, y: span.y1, z: 0 });
    return [[a.y, a.z], [b.y, b.z]] as [number, number][];
  });
}

/** 嚴格橫越判定（共線/端點相觸不算），回傳交點。 */
function segCross(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number],
): [number, number] | null {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  const crosses = ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
    && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
  if (!crosses) return null;
  const s = d1 / (d1 - d2);
  return [a1[0] + s * (a2[0] - a1[0]), a1[1] + s * (a2[1] - a1[1])];
}

/** Andrew monotone chain 凸包（逆時針）。 */
function convexHull(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (input: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of input) {
      while (out.length >= 2) {
        const [o, q] = [out[out.length - 2]!, out[out.length - 1]!];
        if ((q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0]) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    return out;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 點對凸包的有號外距（內部為負·外側正值=凸出量）。 */
function outsideDistance(p: [number, number], hull: [number, number][]): number {
  let maxOut = -Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const crossV = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    maxOut = Math.max(maxOut, -crossV / len);
  }
  return maxOut;
}

describe('TTB 掃掠物理閘門', () => {
  const model = buildTtbFoldModel(resolveParams(triangularTube));
  const spans = stripSpans(model);
  const targets = new Map(model.panels.map((panel) => [panel.id, panel.foldAngle]));
  const deg = (radians: number) => (radians * 180) / Math.PI;

  it('G1 紙不穿紙：剖面折線全程無自交（slot 走廊內的入槽穿越除外）', () => {
    const violations: string[] = [];
    for (let ti = 0; ti <= T_STEPS; ti += 1) {
      const t = ti / T_STEPS;
      const pts = crossSection(model, spans, t);
      for (let i = 0; i < spans.length; i += 1) {
        for (let j = i + 2; j < spans.length; j += 1) {
          const hit = segCross(pts[i * 2]!, pts[i * 2 + 1]!, pts[j * 2]!, pts[j * 2 + 1]!);
          if (!hit) continue;
          const depth = Math.min(pts[j * 2]![1], pts[j * 2 + 1]![1]);
          const isFaceA = spans[i]!.id === 'faceA';
          const farEnd = pts[i * 2 + 1]!;
          const distToCorner = Math.hypot(hit[0] - farEnd[0], hit[1] - farEnd[1]);
          const isTail = spans[j]!.id === 'zoneDLip' || spans[j]!.id === 'zoneDTab';
          const inCorridor = isFaceA && isTail && distToCorner <= SLOT_CORRIDOR_MM;
          const cap = inCorridor ? CORRIDOR_DEPTH_CAP_MM : STRAY_DEPTH_CAP_MM;
          const wallHit = !isFaceA;
          if (wallHit || Math.abs(depth) > cap) {
            violations.push(
              `t=${t.toFixed(3)} ${spans[i]!.id}×${spans[j]!.id} 距角 ${distToCorner.toFixed(1)}mm 深 ${depth.toFixed(2)}mm`,
            );
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('G2 摺向不反向：pose 角不得與目標摺角符號相反超過 0.5°', () => {
    const violations: string[] = [];
    for (let ti = 0; ti <= T_STEPS; ti += 1) {
      const t = ti / T_STEPS;
      const pose = foldPose(t, model);
      for (const { id } of spans) {
        const angle = pose.get(id) ?? 0;
        const target = targets.get(id) ?? 0;
        if (target !== 0 && Math.sign(angle) === -Math.sign(target) && Math.abs(deg(angle)) > 0.5) {
          violations.push(`t=${t.toFixed(3)} ${id} 反向 ${deg(angle).toFixed(1)}°`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('G3 無甩入：zoneD 各 hinge 角速度不超過盒身摺疊節奏', () => {
    let prev = foldPose(0, model);
    const worst = new Map<string, number>();
    for (let ti = 1; ti <= T_STEPS; ti += 1) {
      const pose = foldPose(ti / T_STEPS, model);
      for (const id of ['zoneDBase', 'zoneDLip', 'zoneDTab']) {
        const rate = Math.abs(deg((pose.get(id) ?? 0) - (prev.get(id) ?? 0))) * (T_STEPS / 100);
        worst.set(id, Math.max(worst.get(id) ?? 0, rate));
      }
      prev = pose;
    }
    for (const [id, rate] of worst) {
      expect(rate, `${id} 角速度 ${rate.toFixed(1)}°/0.01t`).toBeLessThanOrEqual(RATE_CAP_DEG);
    }
  });

  it('G4 掃掠段捲入：faceB/faceC 收攏完成時 zoneD 條帶已非剛體直板', () => {
    const faceStep = model.steps.find((step) => step.panelIds.includes('faceC'))!;
    const pose = foldPose(faceStep.t1, model);
    expect(Math.abs(deg(pose.get('zoneDBase') ?? 0))).toBeGreaterThan(30);
    expect(Math.abs(deg(pose.get('zoneDLip') ?? 0))).toBeGreaterThan(15);
  });

  // fold 層視覺 allowance：端封件收剪進盒體輪廓後，t=1 剪影
  // 凸出應歸零（容 0.05mm 浮點/容差餘裕）。刀模 friction-fit 補償材料（原 2.28mm
  // 懸出）僅存在於 2D 輸出，3D 呈現收剪。防塵翼/端蓋破圖（凸出回升）會直接紅。
  it('G5 終幀剪影：t=1 全 panel 超出盒體剖面凸包 ≤0.05mm、軸向不出界', () => {
    const world = worldGeometry(model, foldPose(1, model));
    const tubeLength = resolveParams(triangularTube).tubeLength as number;
    const bodyPts = ['faceA', 'faceB', 'faceC']
      .flatMap((id) => world.get(id)!.map((v) => [v.y, v.z] as [number, number]));
    const hull = convexHull(bodyPts);

    for (const panel of model.panels) {
      for (const v of world.get(panel.id)!) {
        const outside = outsideDistance([v.y, v.z], hull);
        expect(outside, `${panel.id} 剖面凸出 ${outside.toFixed(2)}mm @(${v.y.toFixed(1)},${v.z.toFixed(1)})`)
          .toBeLessThanOrEqual(0.05);
        expect(v.x, `${panel.id} 軸向出界 x=${v.x.toFixed(2)}`).toBeGreaterThanOrEqual(-0.1);
        expect(v.x, `${panel.id} 軸向出界 x=${v.x.toFixed(2)}`).toBeLessThanOrEqual(tubeLength + 0.1);
      }
    }
  });

  // 收束位移上限：edge-on panel（剖面投影成線·
  // WingBottom）的面內最短修正路徑會爆炸——實測外距 2.385mm 需 60mm 面內剪移，
  // t=1 仍在殼內（G5 綠）但形狀全毀、掃掠中段肉眼可見「翼跑掉」。凸包閘門
  // 天生看不到殼內形狀損毀，此門直接鎖 clamp 位移本身：面內位移 ≤8mm、
  // 面外彎入（normalOffset·紙角塞進盒內的微彎）≤3mm。
  it('G6 收束位移：面內位移 ≤8mm、面外彎入 ≤3mm，edge-on 頂點走面外不走面內', () => {
    for (const panel of model.panels) {
      for (const { index, target, normalOffset } of panel.vertexClamp ?? []) {
        const point = panel.polygon[index]!;
        const displacement = Math.hypot(target.x - point.x, target.y - point.y);
        expect(
          displacement,
          `${panel.id} v${index} 面內位移 ${displacement.toFixed(2)}mm（形狀剪歪訊號）`,
        ).toBeLessThanOrEqual(8);
        expect(
          Math.abs(normalOffset ?? 0),
          `${panel.id} v${index} 面外彎入 ${(normalOffset ?? 0).toFixed(2)}mm`,
        ).toBeLessThanOrEqual(3);
      }
    }
    // 行為錨點：WingTop 面內收束（比例健康 ~1.1×·無面外）、WingBottom 面外彎入
    // （edge-on·面內不動）——兩者都有 clamp，t=1 全數收進殼內（G5 嚴格 0.05）。
    const wingTop = model.panels.find(({ id }) => id === 'endStartWingTop')!;
    const wingBottom = model.panels.find(({ id }) => id === 'endStartWingBottom')!;
    expect(wingTop.vertexClamp?.length ?? 0).toBeGreaterThan(0);
    expect(wingTop.vertexClamp!.every(({ normalOffset }) => !normalOffset)).toBe(true);
    expect(wingBottom.vertexClamp?.length ?? 0).toBeGreaterThan(0);
    for (const { index, target, normalOffset } of wingBottom.vertexClamp!) {
      const point = wingBottom.polygon[index]!;
      expect(Math.hypot(target.x - point.x, target.y - point.y)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(normalOffset ?? 0)).toBeGreaterThan(1);
    }
  });
});
