/**
 * P3 M3 F1.0 對位唯一真相源——TEMPLATE（`fold-template.ts`）與 3D UV
 * （`fold-scene.ts`）共同消費本檔輸出，禁止把 2D 補償座標的 `GenerateResult`
 * 刀線拼進來（Spec-M3 v2 §3 F1.0：兩座標系有逐面板累積的紙厚補償差，見
 * `tests/fold/rte-reconcile.test.ts:200-214`）。
 *
 * `flatDielineUvFrame`／`FlatDielineUvFrame` 原本定義在 `fold-scene.ts`——T1 從那裡
 * 搬遷到本檔；`fold-scene.ts` 改為 `import` 本檔再 `export` 回同名稱（既有測試
 * `import { flatDielineUvFrame } from '@/ui/fold-scene'` 零改動、且是同一顆函式
 * reference，不是各自維護一份公式）。
 *
 * `deriveArtworkLayout`：自 `worldGeometry(model, foldPose(0, model))` 取名義攤平
 * 幾何——與 `fold-scene.ts` 現行 UV 生成／`sampleArtworkPlan` 同款呼叫。t=0 時
 * FoldModel 的 pose 對每個非 root 面板角度皆為 0，`hingeRotation(hinge, 0)` 化簡為
 * identity transform（`Math.cos(0)=1`、`Math.sin(0)=0` 為精確值，無浮點誤差），
 * 因此 `worldGeometry` 在 t=0 回傳的每個 panel 頂點與該 panel 宣告時的
 * `polygon`／`hingeLine` 座標逐 bit 相同——這正是全模型共用單一「名義攤平座標系」
 * 的基礎（`validateFoldModel` 的 `isPointOnPolygonEdge`／`polygonEdgeContainsSegment`
 * 也直接對 `panel.polygon` 與 `panel.hingeLine` 做比對、不經任何變換，同一假設）。
 * 因此本檔的 per-panel hinge 線段直接取用 `FoldModel` 原始 `hingeLine`，不需要另外
 * 對 hinge 端點做一次 `worldGeometry` 變換。
 *
 * 純 TS 模組，不 import React／three；`src/fold/` 零變更（只讀既有 export）。
 */
import type { Vec3 } from '../fold/pose3d';
import { worldGeometry } from '../fold/pose3d';
import { foldPose } from '../fold/schedule';
import type { FoldModel, Pt } from '../fold/types';

export interface FlatDielineUvFrame {
  minX: number;
  minY: number;
  span: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 名義攤平幾何的方形 UV 頁框：span=max(width, height)，短軸置中留白
 * （offsetX/offsetY）。TEMPLATE viewBox 與 3D UV 映射共用同一份輸出（F1.0）。
 */
export function flatDielineUvFrame(
  flatGeometry: Map<string, Vec3[]>,
): FlatDielineUvFrame {
  const vertices = [...flatGeometry.values()].flat();
  if (vertices.length === 0) {
    return { minX: 0, minY: 0, span: 1, offsetX: 0, offsetY: 0 };
  }

  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  const span = Math.max(width, height, Number.EPSILON);

  return {
    minX,
    minY,
    span,
    offsetX: (span - width) / 2,
    offsetY: (span - height) / 2,
  };
}

export interface ArtworkLayoutPanel {
  id: string;
  /** 名義攤平座標系（t=0）下的面板外緣，逐點對齊 `worldGeometry` 輸出。 */
  polygon: Pt[];
  /**
   * 摺線線段（模板 crease 用）；root 面板（`parent === null`，本模型即 P1）沒有
   * hinge。座標與 `polygon` 同一份名義攤平座標系——見本檔頂部 docblock 的
   * identity-transform 說明。
   */
  hinge?: { a: Pt; b: Pt };
}

export interface ArtworkLayout {
  panels: ArtworkLayoutPanel[];
  /** square UV frame——TEMPLATE viewBox 與 3D UV 映射共用同一份。 */
  frame: FlatDielineUvFrame;
}

/** F1.0 對位唯一真相：TEMPLATE builder 與 3D UV 生成皆消費本函式輸出。 */
export function deriveArtworkLayout(model: FoldModel): ArtworkLayout {
  const flatGeometry = worldGeometry(model, foldPose(0, model));
  const panels: ArtworkLayoutPanel[] = model.panels.map((panel) => {
    const vertices = flatGeometry.get(panel.id) ?? [];
    const layoutPanel: ArtworkLayoutPanel = {
      id: panel.id,
      polygon: vertices.map(({ x, y }) => ({ x, y })),
    };
    if (panel.hingeLine !== undefined) {
      layoutPanel.hinge = panel.hingeLine;
    }
    return layoutPanel;
  });

  return { panels, frame: flatDielineUvFrame(flatGeometry) };
}

/**
 * Stable identity for the coordinates that an uploaded square artwork is aligned to.
 * Fold-only metadata such as paper thickness and pose is intentionally absent.
 */
export function artworkLayoutSignature(model: FoldModel): string {
  const layout = deriveArtworkLayout(model);
  return JSON.stringify([
    [
      layout.frame.minX,
      layout.frame.minY,
      layout.frame.span,
      layout.frame.offsetX,
      layout.frame.offsetY,
    ],
    layout.panels.map(({ id, polygon }) => [
      id,
      polygon.map(({ x, y }) => [x, y]),
    ]),
  ]);
}
