/**
 * P3 e2e/DEV 測試接線（main 側常駐·production tree-shake）。
 *
 * `__p3SetInitialFoldProgress` 必須在 FOLD chunk 載入前即可呼叫——e2e 可逆性
 * 獨立 oracle 於進 FOLD **前**注入 flat 起始 pose（flat baseline 不經非零
 * pose）。FoldView lazy 化（M3 C7b lazy boundary）後其 module top-level 到切
 * FOLD 才執行，註冊段因此遷居本模組並由 App 靜態 import 保證載入時序。
 * production（非 DEV／非 e2e mode）整段 dead-code 消除——tree-shake grep
 * 驗證照舊（T6）。
 */
export const P3_TEST_HOOKS_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'e2e';

let nextInitialFoldProgress: number | undefined;

function clampFoldProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

if (P3_TEST_HOOKS_ENABLED && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__p3SetInitialFoldProgress = (progress: number) => {
    nextInitialFoldProgress = Number.isFinite(progress) ? clampFoldProgress(progress) : 0;
  };
}

/** FoldView mount 時讀取 e2e 注入的起始 pose（無注入=undefined）。 */
export function peekInitialFoldProgress(): number | undefined {
  return nextInitialFoldProgress;
}

/** 一次性消費語義：scene 建立後清除，下次 mount 回預設。 */
export function clearInitialFoldProgress(): void {
  nextInitialFoldProgress = undefined;
}
