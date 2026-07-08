/**
 * DXF 文字輸出的最小可用解析器——供測試斷言用，不是給正式 export 路徑消費（那邊只管寫，
 * 這邊負責讀回來驗證寫對了）。
 *
 * 獨立成非 `.test.ts` 命名的檔案（而非留在 `dxf.test.ts` 內 export）：Vitest 的 collection
 * 模型下，`describe`/`it` 是模組執行當下綁定的全域，靜態 import 一個 *.test.ts 檔案會連帶
 * 重新執行它自己頂層的 describe——`tests/ui/app.test.tsx` 原本從 `tests/export/dxf.test.ts`
 * 匯入 `parseDxf` 時，dxf.test.ts 自己的 12 個測試因此在 app.test.tsx 的 suite 裡「重複」
 * 執行了一次（review F1，總數虛報 429，實際 417）。搬到這個非 `.test.` 命名的檔案後，
 * Vitest 預設的 `include` glob（比對 `.test.`/`.spec.`）不會把它當測試檔收集，兩邊 import
 * 都只拿到函式本身，不再連帶重跑任何 describe。
 *
 * 逐行讀 group code/value 配對、依 0 碼切「記錄」（SECTION/TABLE/LAYER/LINE/ARC/POLYLINE/
 * VERTEX/SEQEND/…），依所在 SECTION 分類成 layers（TABLES 段的 LAYER 名稱）與 entities
 * （ENTITIES 段的每筆記錄）。結構性記錄（SECTION/ENDSEC/TABLE/ENDTAB/EOF）本身不算 layer
 * 也不算 entity。`tests/export/dxf.test.ts`（T1）與 `tests/ui/app.test.tsx`（Task 2 下載 UI）
 * 共用同一份，故獨立於任何單一測試案例、盡量通用。
 */

export interface ParsedDxfEntity {
  type: string;
  layer: string;
  codes: Record<number, string[]>;
}

export interface ParsedDxf {
  layers: string[];
  entities: ParsedDxfEntity[];
}

const STRUCTURAL_RECORD_TYPES = new Set(['SECTION', 'ENDSEC', 'TABLE', 'ENDTAB', 'EOF']);

export function parseDxf(text: string): ParsedDxf {
  const raw = text.split('\n');
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([Number(raw[i]!.trim()), raw[i + 1]!.trim()]);
  }

  const layers: string[] = [];
  const entities: ParsedDxfEntity[] = [];
  let section = '';
  let record: { type: string; codes: Record<number, string[]> } | null = null;

  const flush = () => {
    if (record && !STRUCTURAL_RECORD_TYPES.has(record.type)) {
      if (section === 'TABLES' && record.type === 'LAYER') {
        layers.push(record.codes[2]?.[0] ?? '');
      } else if (section === 'ENTITIES') {
        entities.push({ type: record.type, layer: record.codes[8]?.[0] ?? '', codes: record.codes });
      }
    }
    record = null;
  };

  for (const [code, value] of pairs) {
    if (code === 0) {
      flush();
      record = { type: value, codes: {} };
      continue;
    }
    if (!record) continue;
    (record.codes[code] ??= []).push(value);
    if (code === 2 && record.type === 'SECTION') section = value;
  }
  flush();

  return { layers, entities };
}
