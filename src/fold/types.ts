import type { Segment } from '../core/geometry';

export interface Pt { x: number; y: number }
export interface FoldDielinePath {
  id: string;
  type: 'cut' | 'crease';
  segments: Segment[];
}
export interface SeamSegment {
  points: Pt[];
  ownerPanelId: string;
  sourcePathId: string;
}
export interface FoldHingeLine {
  a: Pt;
  b: Pt;
  /** Fold-model-only split used for motion; not a physical crease in the dieline. */
  virtual?: boolean;
}
export interface FoldPanel {
  id: string;
  polygon: Pt[];              // 名義攤平座標系·winding 一律 CCW
  parent: string | null;
  hingeLine?: FoldHingeLine;
  hingeSourceCreaseIds?: string[];
  foldAngle: number;          // rad·符號=繞 hinge 軸（a→b 方向）右手定則
  // 沿摺合後面板法向的視覺偏移·僅允許 leaf 面板（validate 強制）·M0 幾何語義=
  // liftOffset×(|angle|/|foldAngle|) 線性漸入（M1 動畫層若改 step 尾 20% 曲線需同步修此註解與 pose3d）。
  liftOffset?: number;
  // 視覺 allowance：越界頂點的收束目標（名義攤平座標）。polygon 本身不動（攤平=
  // 真刀模不變式），worldGeometry 依 |angle|/|foldAngle| 完成度把頂點 lerp 到 target
  // ——刀模 friction-fit 補償材料在 3D 摺合時「壓進」盒體輪廓的零厚度近似。
  // normalOffset（選配）：面外彎入量（panel 局部 z·完成度 lerp）——edge-on panel
  // 的面內收束不成比例（剖面投影成線），改沿法向微彎塞進殼內（紙角受擠的物理近似）。
  vertexClamp?: { index: number; target: Pt; normalOffset?: number }[];
}
export type EaseName = 'linear' | 'powerInOut' | 'backIn';
export interface FoldStep  { panelIds: string[]; t0: number; t1: number; ease: EaseName }
export interface FoldModel {
  panels: FoldPanel[];
  steps: FoldStep[];
  /** 2D generator 的完整 cut/crease 繪製集，包含 inactive segments。 */
  dieline: FoldDielinePath[];
  seams?: SeamSegment[];
}
export const ARC_TOLERANCE_MM = 0.25;
export const CLOSURE_TOLERANCE_MM = 0.01;
