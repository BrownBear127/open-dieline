import type { Segment } from '../core/geometry';
import type { FoldModel, FoldPanel, Pt } from './types';

/** 對單點作 x → 2·axisX − x 鏡射（y 不變）。 */
function mirrorPoint(pt: Pt, axisX: number): Pt {
  return { x: 2 * axisX - pt.x, y: pt.y };
}

function mirrorSegment(segment: Segment, axisX: number): Segment {
  const mirrorX = (x: number): number => 2 * axisX - x;
  if (segment.kind === 'line') {
    return { ...segment, x1: mirrorX(segment.x1), x2: mirrorX(segment.x2) };
  }
  if (segment.kind === 'bezier') {
    return {
      ...segment,
      x1: mirrorX(segment.x1),
      c1x: mirrorX(segment.c1x),
      c2x: mirrorX(segment.c2x),
      x2: mirrorX(segment.x2),
    };
  }
  return {
    ...segment,
    cx: mirrorX(segment.cx),
    startAngle: Math.PI - segment.startAngle,
    endAngle: Math.PI - segment.endAngle,
    ccw: !segment.ccw,
  };
}

/**
 * 鏡射單一面板（canonical-left 鏡射規則·本函式是唯一實作·不得自創變體）：
 * - polygon 逐點鏡射後 reverse 頂點序——鏡射（x→2·axisX−x）是 orientation-reversing
 *   映射，逐點鏡射後原本 CCW 會變 CW；reverse 頂點序恢復 CCW（validate 要求正面積）。
 * - hinge a↔b 端點交換（先鏡射座標再交換）——foldAngle 符號不翻：交換端點已把摺線
 *   軸向翻回來，若再翻角號會變成雙重否定（等同沒翻），詳見 pose3d hingeRotation
 *   以 a→b 方向做右手定則旋轉軸。
 * - id/parent/foldAngle/liftOffset 全保留（glue 恆掛 P1——鏡射後物理上在右側，
 *   但樹結構不變，這是 canonical-left 鏡射規則跟 RTE 既有「glue 依 glueOnRight 改掛 P4」
 *   手法的差異）。
 */
function mirrorPanel(panel: FoldPanel, axisX: number): FoldPanel {
  const mirroredPolygon = panel.polygon.map((pt) => mirrorPoint(pt, axisX)).reverse();

  // vertexClamp 隨 polygon 同步鏡射：reverse 後原 index i → n−1−i，target 逐點鏡射。
  // normalOffset（面外彎入）在鏡射下的符號語義未驗證（polygon reverse 翻轉繞向、
  // hinge a↔b 交換翻轉旋轉軸，兩者對局部 z 的合成效應需實例對照）——目前無
  // 「鏡射盒型＋面外收束」使用案例，遇到直接 fail-loud 而非默默給錯符號。
  const vertexCount = panel.polygon.length;
  const mirroredClamp = panel.vertexClamp?.map(({ index, target, normalOffset }) => {
    if (normalOffset !== undefined && normalOffset !== 0) {
      throw new Error(
        `mirrorPanel：panel「${panel.id}」頂點 ${index} 帶 normalOffset，鏡射符號語義未定義`,
      );
    }
    return {
      index: vertexCount - 1 - index,
      target: mirrorPoint(target, axisX),
    };
  });
  const base = mirroredClamp === undefined
    ? { ...panel, polygon: mirroredPolygon }
    : { ...panel, polygon: mirroredPolygon, vertexClamp: mirroredClamp };

  if (panel.hingeLine === undefined) {
    return base;
  }

  return {
    ...base,
    hingeLine: {
      ...panel.hingeLine,
      a: mirrorPoint(panel.hingeLine.b, axisX),
      b: mirrorPoint(panel.hingeLine.a, axisX),
    },
  };
}

/**
 * 把整個 FoldModel 對垂直軸 x=axisX 水平鏡射——ttsl glueSide='right' 版型
 * （見 `src/boxes/tuck-top-snap-lock.ts:624` 2D ground truth 的同語意 mirrorSegmentsX）。
 * 純函式：不 mutate 輸入 model，一律回傳新物件（immutability 鐵則）。
 */
export function mirrorFoldModel(model: FoldModel, axisX: number): FoldModel {
  const mirrored: FoldModel = {
    panels: model.panels.map((panel) => mirrorPanel(panel, axisX)),
    steps: model.steps.map((step) => ({ ...step, panelIds: [...step.panelIds] })),
    dieline: model.dieline.map((path) => ({
      ...path,
      segments: path.segments.map((segment) => mirrorSegment(segment, axisX)),
    })),
  };
  if (model.seams !== undefined) {
    mirrored.seams = model.seams.map((seam) => ({
      ...seam,
      points: seam.points.map((pt) => mirrorPoint(pt, axisX)),
    }));
  }
  return mirrored;
}
