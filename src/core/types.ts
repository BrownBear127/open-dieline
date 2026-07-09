/**
 * 核心型別契約（spec §3.3）——盒型插件架構的骨架。
 *
 * 這是整個專案的公開契約：後續盒型插件（boxes/*.ts）、UI（ParamPanel/Canvas）、
 * 匯出（export/svg.ts、export/dxf.ts）全部依賴這裡的型別簽章。
 * 純 TS 模組，不 import React 或任何 UI。
 */

import type { Segment, Bounds } from '@/core/geometry';

/** 多語文字欄位；v1 只填 zh（en 保留供未來擴充，見 spec D10）。 */
export type LocalizedText = { zh: string; en?: string };

/** 線型分類——styles.ts 的 LINE_STYLES 以此為 key，是畫布與匯出唯一共享的樣式映射。 */
export type LineType = 'cut' | 'crease' | 'halfcut' | 'bleed' | 'annotation' | 'dimension';

/** 單條刀模路徑：同一線型的一組 Segment；tags 供 UI hover 高亮對應到 highlightTags。 */
export interface DielinePath {
  id: string;
  type: LineType;
  segments: Segment[];
  tags?: string[];
}

/** 畫布/匯出顯示的文字標註（如尺寸標註數字）。 */
export interface DielineText {
  id: string;
  x: number;
  y: number;
  text: string;
  rotation?: number;
  fontSize?: number;
  anchor?: 'start' | 'middle' | 'end';
}

/**
 * 多片盒型（如天地盒三件套：上蓋／下盒／內襯）的「片」（spec §3.3 v1.2）。
 * 片的「語意身分」（哪片是 lid）型別層不管，由各盒型自己的不變式綁定；
 * pathIds/textIds 的歸屬完整性規則見 core/pieces.ts 的 validatePieces()。
 */
export interface DielinePiece {
  /**
   * 契約（Slice 4 final 迴歸 review）：同一盒型跨 `generate()` 呼叫，**相同 id 必須永久
   * 代表同一語意片**——按角色命名（`base`/`lid`/`liner`），不得按當次陣列位置命名
   * （`slot-0` 這類 id 在參數改變交換位置語意時，會讓拼版的「選中件」靜默換片：
   * App 只以「同 id 仍存在」判斷選擇是否沿用）。新盒型的 conformance 測試應以參數
   * 切換前後交叉驗證此穩定性。
   */
  id: string;
  label: LocalizedText;
  pathIds: string[];
  textIds: string[];
  bounds: Bounds;
}

/** 盒型 generate() 的完整輸出——畫布渲染與兩種匯出共用的同一份資料（spec §3.2 幾何單一來源）。 */
export interface GenerateResult {
  paths: DielinePath[];
  texts: DielineText[];
  bounds: Bounds;
  /** 省略＝單片盒型（RTE 不變、向後相容）；有值時的完整性規則見 core/pieces.ts。 */
  pieces?: DielinePiece[];
}

/** resolveParams() 解析後的參數快照；型別上唯讀。 */
export type ResolvedParams = Readonly<Record<string, number | boolean | string>>;

/**
 * 單一參數的宣告。
 *
 * derivedDefault：使用者未手動覆寫該欄位時，用來即時重算顯示值的函式；
 * 只可讀取「宣告順序中先前」已解析的參數——registry.ts 的 resolveParams 強制此規則，
 * 讀到尚未解析的 key 視為前向引用並擲錯（不可默默算出 NaN）。
 */
export interface BoxParamDef {
  key: string;
  label: LocalizedText;
  unit: 'mm' | 'deg' | 'bool' | 'enum';
  default: number | boolean | string;
  options?: { value: string; label: LocalizedText }[]; // unit='enum' 必填
  min?: number;
  max?: number;
  step?: number;
  group: LocalizedText;
  description: LocalizedText; // 教育說明：此參數在盒型結構上的意義（一級公民）
  highlightTags?: string[];
  derivedDefault?: (params: ResolvedParams) => number;
}

/** 幾何不變式：測試（CI）與 UI runtime 警告共用同一份 check 邏輯。 */
export interface BoxInvariant {
  id: string;
  description: LocalizedText; // 也是教材：這條幾何規則為什麼存在
  check: (
    params: ResolvedParams,
    result: GenerateResult,
  ) => { ok: true } | { ok: false; message: LocalizedText; tags?: string[] };
}

/** 一個盒型插件的完整契約：meta 描述＋參數宣告＋不變式＋生成函式。 */
export interface BoxModule {
  meta: {
    id: string;
    name: LocalizedText;
    intro: LocalizedText;
    topology: string;
  };
  params: BoxParamDef[];
  invariants: BoxInvariant[];
  generate: (params: ResolvedParams) => GenerateResult;
}
