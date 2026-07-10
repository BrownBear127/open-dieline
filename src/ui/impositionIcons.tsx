/**
 * 拼版 toolbar 按鈕用的 inline SVG 圖示（gate round 1 T4：紙規／方向／裁切／旋轉四組
 * toolbar 按鈕改用圖示＋短 label，取代 T1 暫時形態的純文字下拉／checkbox）。
 *
 * 全部是純展示元件——零 props、零狀態、零副作用，`ImpositionView.tsx` 的
 * `ImpositionControls` 依目前 `state` 挑選要渲染哪一顆，圖示本身不知道、也不需要知道
 * 自己是否「選中」（選中態的視覺差異由按鈕的 `toolbarButtonClass` 負責，不是圖示）。
 *
 * 統一走 `stroke="currentColor"`：按鈕文字與圖示共用同一個 `text-*` 色票（選中態
 * `text-white`／未選 `text-zinc-600`），圖示顏色自動跟著按鈕狀態變化，不必為選中/未選
 * 兩態各畫一份圖示。`aria-hidden="true"` 是刻意的可及性設計，不是遺漏：按鈕的 accessible
 * name 必須只來自旁邊的文字 label（如「橫放」／「對開 V」），圖示若不隱藏，name-from-content
 * 演算法會把圖示內部的 `<path>`／`<text>` 也一併纳入，測試與螢幕報讀器都會讀到不必要的
 * 雜訊（尤其紙規三顆圖示內嵌了 preset 簡碼文字，見下方）。
 */

/** 20×20／currentColor／無填色／1.5px 線寬——每顆圖示的 `<svg>` 共用同一組屬性，集中
 *  一處定義避免九顆圖示各自手key、其中一顆漏改就跟其他圖示視覺不一致。 */
const ICON_SVG_PROPS = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  stroke: 'currentColor',
  fill: 'none',
  strokeWidth: 1.5,
  'aria-hidden': true,
} as const;

/** 直放：瘦高矩形。 */
export function IconPortrait() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="6" y="2" width="8" height="16" rx="1" />
    </svg>
  );
}

/** 橫放：寬扁矩形（與 IconPortrait 同一顆矩形轉 90°的視覺對稱，呼應「方向」語意）。 */
export function IconLandscape() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="2" y="6" width="16" height="8" rx="1" />
    </svg>
  );
}

/** 對開 V（左右對切）：矩形＋一條豎直虛線，示意裁切線把紙張切成左右兩半。 */
export function IconCutV() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <line x1="10" y1="3" x2="10" y2="17" strokeDasharray="2 2" />
    </svg>
  );
}

/** 對開 H（上下對切）：矩形＋一條橫直虛線，示意裁切線把紙張切成上下兩半。 */
export function IconCutH() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <line x1="3" y1="10" x2="17" y2="10" strokeDasharray="2 2" />
    </svg>
  );
}

/** 可轉 90°：矩形（代表拼版件）＋一段弧形旋轉箭頭，示意件可轉向後補排。 */
export function IconRotate() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="3" y="8" width="9" height="9" rx="1" />
      <path d="M8.5 4a6.5 6.5 0 1 1-5.6 9.5" strokeLinecap="round" />
      <path d="M8.5 1.3v3.2h-3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 紙規／自訂圖示共用的「文件折角」外框：矩形右上角削去一個小三角形＋折角摺線，
 *  是通用的「一張紙／一份文件」象形，三顆 preset 圖示與下面的 IconPaperCustom 共用同一個
 *  外框、只有內嵌小字或內容不同——保持四顆紙規按鈕的視覺語言一致（使用者一眼認出「這排都是
 *  紙規」），差異只在看得清楚的那一個標籤。 */
function PaperOutline() {
  return (
    <>
      <path d="M5 2h7l3 3v13H5z" />
      <path d="M12 2v3h3" />
    </>
  );
}

/** 31"×43" 紙規：文件外框＋內嵌簡碼「31」（矩形內小字，T4 現場定案：三顆 preset 尺寸比例
 *  彼此太接近，縮到 20×20 難以用比例本身分辨，直接標數字最清楚）。 */
export function IconPaper3143() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <PaperOutline />
      <text x="9.5" y="14" fontSize="6" fontFamily="sans-serif" fontWeight="600" fill="currentColor" stroke="none" textAnchor="middle">
        31
      </text>
    </svg>
  );
}

/** 25"×35" 紙規：同上，簡碼「25」。 */
export function IconPaper2535() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <PaperOutline />
      <text x="9.5" y="14" fontSize="6" fontFamily="sans-serif" fontWeight="600" fill="currentColor" stroke="none" textAnchor="middle">
        25
      </text>
    </svg>
  );
}

/** 27"×39" 紙規：同上，簡碼「27」。 */
export function IconPaper2739() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <PaperOutline />
      <text x="9.5" y="14" fontSize="6" fontFamily="sans-serif" fontWeight="600" fill="currentColor" stroke="none" textAnchor="middle">
        27
      </text>
    </svg>
  );
}

/** 自訂紙規：虛線外框（示意「尺寸未定、待填」，與三顆 preset 的實線外框做出區隔）＋一枝
 *  小鉛筆（示意「可編輯」）。 */
export function IconPaperCustom() {
  return (
    <svg {...ICON_SVG_PROPS}>
      <rect x="3" y="2" width="12" height="16" rx="1" strokeDasharray="2 2" />
      <path d="M14 10.5a1.8 1.8 0 0 1 2.5 2.5L12.5 17l-2.5.5.5-2.5 3.5-4.5z" />
    </svg>
  );
}
