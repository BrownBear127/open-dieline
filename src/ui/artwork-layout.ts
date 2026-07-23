/**
 * TEMPLATE、3D UV 與編輯器共同消費的攤平版面。面板、摺線及縫線皆沿用
 * `FoldModel` 從 2D generator 導出的補償後真刀模座標。
 */
import type { Vec3 } from '../fold/pose3d';
import { worldGeometry } from '../fold/pose3d';
import { foldPose } from '../fold/schedule';
import type { FoldDielinePath, FoldHingeLine, FoldModel, Pt } from '../fold/types';

export interface FlatDielineUvFrame {
  minX: number;
  minY: number;
  span: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 攤平幾何的方形 UV 頁框：span=max(width, height)，短軸置中留白。
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
  /** 補償後真刀模座標系（t=0）下的面板外緣。 */
  polygon: Pt[];
  /** 模板 crease 使用的摺線；root 面板沒有 hinge。 */
  hinge?: FoldHingeLine;
}

export interface ArtworkLayout {
  panels: ArtworkLayoutPanel[];
  /** 2D Canvas/SVG export 同源的完整 cut/crease 繪製集。 */
  dieline: FoldDielinePath[];
  /** 補償後真刀模座標系下的內部刀線。 */
  seams: Array<{ points: Pt[] }>;
  /** square UV frame——TEMPLATE viewBox 與 3D UV 映射共用同一份。 */
  frame: FlatDielineUvFrame;
}

/** TEMPLATE builder、編輯器與 3D UV 生成共用的攤平版面。 */
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

  const seams = (model.seams ?? []).map(({ points }) => ({
    points: points.map(({ x, y }) => ({ x, y })),
  }));
  const dieline = model.dieline.map((path) => ({
    ...path,
    segments: path.segments.map((segment) => ({ ...segment })),
  }));

  return { panels, dieline, seams, frame: flatDielineUvFrame(flatGeometry) };
}

/**
 * Stable identity for the coordinates that an uploaded square artwork is aligned to.
 * Fold-only metadata such as paper thickness and pose is intentionally absent.
 *
 * 純字串計算抽成 `artworkLayoutSignatureFromLayout`：TEMPLATE builder（已握有算好的
 * `ArtworkLayout`）與本函式共用同一份公式，不各自複製一份、不必為了嵌 hash 重跑
 * `deriveArtworkLayout`／`worldGeometry`。
 */
export function artworkLayoutSignature(model: FoldModel): string {
  return artworkLayoutSignatureFromLayout(deriveArtworkLayout(model));
}

export function artworkLayoutSignatureFromLayout(layout: ArtworkLayout): string {
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

/** FNV-1a 32-bit——`reverse` 走訪方向與 `offsetBasis` 皆可調，供組出兩個結構不同、
 *  非同一次計算重複輸出的獨立變體（見 `hashArtworkLayoutSignature`）。 */
function fnv1a32(text: string, offsetBasis: number, reverse: boolean): number {
  let hash = offsetBasis;
  const step = reverse ? -1 : 1;
  const start = reverse ? text.length - 1 : 0;
  const end = reverse ? -1 : text.length;
  for (let index = start; index !== end; index += step) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * 64-bit 指紋（16 hex 字元）＝兩個獨立 32-bit FNV-1a 變體拼接——同步、無依賴、
 * Node/瀏覽器逐位元相同（純 bitwise 算術）。用途是上傳
 * 對位的 UX 提示訊號（模板是否在下載後又改了參數），不是安全邊界，不需要密碼學
 * 等級的碰撞抵抗；雙 seed 收斂單一 32-bit 版的碰撞機率
 * （方向良性——碰撞只會漏掉 stale-template 警示，不會誤報——但仍值得從
 * 1-in-4-billion 收斂到 1-in-1.8×10^19）。
 * 兩變體刻意用不同走訪方向＋不同 offset basis，非同一次計算的複製品。
 */
export function hashArtworkLayoutSignature(signature: string): string {
  const forward = fnv1a32(signature, 0x811c_9dc5, false);
  const reversed = fnv1a32(signature, 0x9e37_79b9, true);
  return forward.toString(16).padStart(8, '0') + reversed.toString(16).padStart(8, '0');
}
