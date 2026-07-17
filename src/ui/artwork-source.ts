/**
 * P3 M3 設計稿上傳管線（T0 skeleton——T2 落實作）。
 * 契約（Spec-M3 v2 F2/F2.1/F3.1）：驗證（MIME/bytes/像素/SVG viewBox）→
 * rasterize 2048×2048 square frame → CustomArtworkSource（transaction·blob URL
 * 恰一次 revoke）。lazy import 專用——本模組禁被 main 靜態 import（J1 C7b）。
 */
export async function loadArtworkFile(_file: File): Promise<void> {}
