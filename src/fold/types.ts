export interface Pt { x: number; y: number }
export interface FoldPanel {
  id: string;
  polygon: Pt[];              // 名義攤平座標系·winding 一律 CCW
  parent: string | null;
  hingeLine?: { a: Pt; b: Pt };
  foldAngle: number;          // rad·符號=繞 hinge 軸（a→b 方向）右手定則
  liftOffset?: number;        // 沿摺合後面板法向·t=1 漸入（step 尾 20% 線性升至全值）
}
export type EaseName = 'linear' | 'powerInOut' | 'backIn';
export interface FoldStep  { panelIds: string[]; t0: number; t1: number; ease: EaseName }
export interface FoldModel { panels: FoldPanel[]; steps: FoldStep[] }
export const ARC_TOLERANCE_MM = 0.25;
export const CLOSURE_TOLERANCE_MM = 0.01;
