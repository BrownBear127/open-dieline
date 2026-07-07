# open-dieline v1 Slice 1 — 幾何核心 + RTE + UI 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 open-dieline 的幾何核心（結構化 Segment）、移植 RTE 反插盒、蓋出 schema-driven 參數面板與畫布 UI、SVG 匯出——一個可跑可驗收的單盒型刀模產生器。

**Architecture:** 純前端 Vite + React + TS。`core/`（純 TS 零 React：Segment 幾何、PathBuilder、樣式表、型別契約、registry）→ `boxes/`（盒型插件）→ `export/svg.ts` 與 `ui/` 同時消費 GenerateResult 與 styles.ts（單一來源）。Spec＝`docs/specs/2026-07-07-open-dieline-v1-design.md`（v1.1）。

**Tech Stack:** Vite 6、React 19、TypeScript（strict）、vitest + @testing-library/react + jsdom、Tailwind CSS 4。

**Slice 2+（本 plan 不含，樣張 gate 過後另寫 plan）：** 天地盒（量測表→fixture→generate）、overlay 對照、DXF、拼版、開源配套（README/LICENSE/CI/Pages）、final review。

## Global Constraints（每個 task 隱含適用）

- 語言：UI 文字與註解繁體中文；文字欄位一律 `LocalizedText`（v1 只填 `zh`）
- 座標單位一律 mm；數值輸出精度 `toFixed(2)`
- 線色慣例：cut=`#000000`、crease=`#00FF00`、halfcut=`#FFFF00`、dimension=`#3B82F6`（只存在 `core/styles.ts`）
- `core/` 與 `boxes/` 禁止 import React 或任何 UI 模組
- v1 盒型 generate 不得產出 `bleed` 線型（不變式強制）
- TDD：每步先紅後綠；commit 訊息 `<type>: <描述>` 繁中，含 Co-Authored-By（見既有 commits）
- 前身參照（唯讀，勿修改）：`/Users/fran/Desktop/trouver.crm-rebuild/components/Tools/Packaging/`

---

### Task 1: 專案 scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/ui/App.tsx`(佔位), `src/index.css`, `.gitignore`
- Test: 無（本 task 驗證＝工具鏈可跑）

**Interfaces:**
- Produces: `npm run dev`/`npm test`/`npm run build` 三命令可用；路徑別名 `@/` → `src/`

- [ ] **Step 1: 建立 package.json 與安裝依賴**

```json
{
  "name": "open-dieline",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Run: `cd ~/projects/open-dieline && npm install react react-dom && npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom vitest jsdom @testing-library/react @testing-library/jest-dom tailwindcss @tailwindcss/vite`

- [ ] **Step 2: 設定檔**

`vite.config.ts`：
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { environment: 'jsdom', globals: true },
});
```

`tsconfig.json`：strict 全開（`"strict": true, "noUncheckedIndexedAccess": true`）、`"paths": {"@/*": ["./src/*"]}`、`"types": ["vitest/globals"]`。

`index.html` 掛 `<div id="root">`＋`src/main.tsx` render `<App/>`；`src/ui/App.tsx` 先回 `<h1>open-dieline</h1>`；`src/index.css` 首行 `@import "tailwindcss";`。

`.gitignore`：`node_modules/`, `dist/`, `refs/`, `*.ai`, `*.eps`（spec §9.3 私有資產防呆）。

- [ ] **Step 3: 驗證工具鏈**

Run: `npm run build && npm test`
Expected: build 成功；vitest 報 "no test files found"（exit 0，vitest run 對零測試預設 pass——若非，加 `--passWithNoTests`）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: Vite+React+TS+vitest+Tailwind scaffold"
```

---

### Task 2: core/geometry.ts — Segment 型別與運算

**Files:**
- Create: `src/core/geometry.ts`
- Test: `tests/core/geometry.test.ts`

**Interfaces:**
- Produces（後續全部 task 依賴的幾何基石）:
```ts
export type Segment =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; startAngle: number; endAngle: number; ccw: boolean }
  | { kind: 'bezier'; x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number };
export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export function segmentBounds(s: Segment): Bounds;          // arc 需考慮跨象限極值點
export function segmentsBounds(list: Segment[]): Bounds;
export function flattenBezier(b: Extract<Segment,{kind:'bezier'}>, chordTol?: number, maxSegLen?: number): Extract<Segment,{kind:'line'}>[];  // de Casteljau 遞迴，預設 chordTol=0.1, maxSegLen=5（spec §6.2）
export function normalizeSegments(list: Segment[], precision?: number): string[];  // 每段→精度化(預設0.01)+端點正規排序的字串，整體 sort——golden/等價比對用（spec §8）
export function hasNaN(list: Segment[]): boolean;
```

- [ ] **Step 1: 寫失敗測試（代表案例）**

```ts
import { describe, it, expect } from 'vitest';
import { segmentBounds, flattenBezier, normalizeSegments, hasNaN } from '@/core/geometry';

describe('segmentBounds', () => {
  it('line 的 bounds 是端點包絡', () => {
    expect(segmentBounds({ kind: 'line', x1: 10, y1: -5, x2: 3, y2: 8 }))
      .toEqual({ minX: 3, maxX: 10, minY: -5, maxY: 8 });
  });
  it('跨 0° 的 arc 要含最右極值點 (cx+r)', () => {
    // 從 -45° 到 45°、半徑 10、圓心 (0,0)：maxX 必須是 10（0° 極值），不是端點的 7.07
    const b = segmentBounds({ kind: 'arc', cx: 0, cy: 0, r: 10, startAngle: -Math.PI/4, endAngle: Math.PI/4, ccw: false });
    expect(b.maxX).toBeCloseTo(10, 5);
  });
});

describe('flattenBezier', () => {
  it('離散結果對曲線的弦高誤差 ≤0.1mm', () => {
    const bez = { kind: 'bezier' as const, x1: 0, y1: 0, c1x: 0, c1y: 10, c2x: 10, c2y: 10, x2: 10, y2: 0 };
    const lines = flattenBezier(bez);
    // 抽樣曲線上 100 點，每點到折線的最短距離 ≤ 0.1
    // （測試內用 de Casteljau 求值函式取樣——實作於測試檔內，不依賴被測模組的內部）
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.x1).toBe(0);
    expect(lines[lines.length - 1]!.x2).toBe(10);
  });
});

describe('normalizeSegments', () => {
  it('同幾何不同順序/方向 → 相同 normalized 輸出', () => {
    const a = [{ kind: 'line' as const, x1: 0, y1: 0, x2: 5, y2: 5 }];
    const b = [{ kind: 'line' as const, x1: 5, y1: 5, x2: 0, y2: 0 }];  // 反向
    expect(normalizeSegments(a)).toEqual(normalizeSegments(b));
  });
});

describe('hasNaN', () => {
  it('偵測任一欄位 NaN', () => {
    expect(hasNaN([{ kind: 'line', x1: NaN, y1: 0, x2: 1, y2: 1 }])).toBe(true);
  });
});
```

另補案例（每條一測試）：arc 完整圓（4 極值點都含）；ccw 方向的極值判斷；flattenBezier 對近直線曲線只產 1-2 段；maxSegLen=5 上限生效（長平緩曲線被切段）；normalizeSegments 精度（0.014 與 0.006 化為 0.01 與 0.01）；空陣列 bounds 回 `{0,0,0,0}`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/core/geometry.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**

要點：arc bounds＝兩端點＋落在 [start,end] 弧範圍內的 0/90/180/270° 極值點（注意 ccw 與角度環繞正規化——寫一個 `angleInArc(θ, start, end, ccw)` 內部函式）；flattenBezier＝遞迴 de Casteljau：中點弦高 > tol 或段長 > maxSegLen 就對半分；normalizeSegments＝line 端點按 (x,y) 字典序排序成 canonical 方向、arc 角度正規化到 [0,2π)、全欄位 `toFixed(2 位精度依 precision)`、序列化成 `kind|欄位…` 字串後整體 sort。

- [ ] **Step 4: 跑測試綠**

Run: `npx vitest run tests/core/geometry.test.ts` → PASS

- [ ] **Step 5: Commit** `feat: Segment 幾何核心（bounds/離散/正規化）`

---

### Task 3: core/path.ts — PathBuilder

**Files:**
- Create: `src/core/path.ts`
- Test: `tests/core/path.test.ts`

**Interfaces:**
- Consumes: `Segment`（Task 2）
- Produces:
```ts
export class PathBuilder {
  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  arcTo(r: number, sweep: 0 | 1, x: number, y: number): this;  // SVG endpoint 語法（rx=ry=r, largeArc=0）→ 內部轉 center 參數化 Arc
  bezierTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this;
  segments(): Segment[];
}
export function segmentsToSvgD(segs: Segment[]): string;  // 投影：連續段合併為單一 d（M…L…A…C…），精度 toFixed(2)
```

- [ ] **Step 1: 失敗測試**

```ts
import { PathBuilder, segmentsToSvgD } from '@/core/path';

it('lineTo 產生 line segment', () => {
  const segs = new PathBuilder().moveTo(0, 0).lineTo(10, 0).segments();
  expect(segs).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]);
});

it('arcTo 端點語法轉 center 參數化：90° 圓角', () => {
  // 從 (0,-5) 以 r=5、sweep=1 到 (5,0)：圓心應為 (0+5? → 依幾何 (5,-5)…) 驗證圓心到兩端點距離皆 r 且掃過 90°
  const segs = new PathBuilder().moveTo(0, -5).arcTo(5, 1, 5, 0).segments();
  const a = segs[0]!;
  expect(a.kind).toBe('arc');
  if (a.kind === 'arc') {
    expect(Math.hypot(a.cx - 0, a.cy - -5)).toBeCloseTo(5, 6);
    expect(Math.hypot(a.cx - 5, a.cy - 0)).toBeCloseTo(5, 6);
  }
});

it('segmentsToSvgD 連續段共用起點只發一次 M', () => {
  const d = segmentsToSvgD(new PathBuilder().moveTo(0, 0).lineTo(10, 0).lineTo(10, 5).segments());
  expect(d).toBe('M0.00,0.00 L10.00,0.00 L10.00,5.00');
});
```

另補：arcTo sweep=0 與 sweep=1 圓心落在弦兩側（鏡像）；不連續段（第二個 moveTo）→ d 內出現第二個 M；arc 投影回 SVG `A r r 0 0 sweep x y` 格式正確；bezier 投影 `C`。

- [ ] **Step 2: 跑紅** → FAIL
- [ ] **Step 3: 實作**

arcTo 數學（endpoint→center，rx=ry、largeArc=0 簡化版）：弦中點 ± 垂直方向偏移 `h = sqrt(r² − (chord/2)²)`，sweep 決定取哪一側（sweep=1 順時針＝圓心在弦行進方向左側；以單元測試錨定，勿憑直覺）。角度＝`atan2(端點−圓心)`；ccw＝`sweep===0`。

- [ ] **Step 4: 跑綠**
- [ ] **Step 5: Commit** `feat: PathBuilder 與 SVG d 投影`

---

### Task 4: core/types.ts + styles.ts + registry.ts

**Files:**
- Create: `src/core/types.ts`, `src/core/styles.ts`, `src/core/registry.ts`
- Test: `tests/core/registry.test.ts`, `tests/core/styles.test.ts`

**Interfaces:**
- Consumes: `Segment`, `Bounds`（Task 2）
- Produces（spec §3.3 全型別，逐字照 spec）:
```ts
// types.ts
export type LocalizedText = { zh: string; en?: string };
export type LineType = 'cut' | 'crease' | 'halfcut' | 'bleed' | 'annotation' | 'dimension';
export interface DielinePath { id: string; type: LineType; segments: Segment[]; tags?: string[] }
export interface DielineText { id: string; x: number; y: number; text: string; rotation?: number; fontSize?: number; anchor?: 'start' | 'middle' | 'end' }
export interface GenerateResult { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds }
export type ResolvedParams = Readonly<Record<string, number | boolean | string>>;
export interface BoxParamDef { key: string; label: LocalizedText; unit: 'mm' | 'deg' | 'bool' | 'enum'; default: number | boolean | string; options?: { value: string; label: LocalizedText }[]; min?: number; max?: number; step?: number; group: LocalizedText; description: LocalizedText; highlightTags?: string[]; derivedDefault?: (params: ResolvedParams) => number }
export interface BoxInvariant { id: string; description: LocalizedText; check: (params: ResolvedParams, result: GenerateResult) => { ok: true } | { ok: false; message: LocalizedText; tags?: string[] } }
export interface BoxModule { meta: { id: string; name: LocalizedText; intro: LocalizedText; topology: string }; params: BoxParamDef[]; invariants: BoxInvariant[]; generate: (params: ResolvedParams) => GenerateResult }

// styles.ts —— 線型樣式唯一來源（spec §3.2）
export const LINE_STYLES: Record<LineType, { stroke: string; strokeWidth: number; dasharray?: string }>;
// cut:#000000/0.4、crease:#00FF00/0.4/dash "4 2"、halfcut:#FFFF00/0.4/dash "1 1"、
// bleed:#FF00FF/0.3、annotation:#888888/0.25、dimension:#3B82F6/0.25

// registry.ts
export function registerBox(m: BoxModule): void;   // 重複 id 擲錯
export function getBox(id: string): BoxModule;     // 不存在擲錯
export function listBoxes(): BoxModule[];
export function resolveParams(m: BoxModule, overrides?: Partial<Record<string, number | boolean | string>>): ResolvedParams;
// resolveParams：按宣告順序解析；derivedDefault 只可讀先前參數（讀到未解析 key 擲錯=前向引用防範）；overrides 覆蓋對應 key（含被 derive 的）
```

- [ ] **Step 1: 失敗測試**

```ts
// registry.test.ts 代表案例
it('resolveParams 按宣告順序解析 derivedDefault', () => {
  const mod = fakeBox([
    { key: 'D', unit: 'mm', default: 100, ... },
    { key: 'lid', unit: 'mm', default: 0, derivedDefault: p => (p.D as number) * 0.4, ... },
  ]);
  expect(resolveParams(mod)).toMatchObject({ D: 100, lid: 40 });
});
it('前向引用擲錯', () => { /* lid 在 D 之前宣告且 derive 讀 D → throw */ });
it('overrides 覆蓋 derived 值', () => { /* overrides:{lid:55} → lid=55 */ });
it('registerBox 重複 id 擲錯', () => { ... });

// styles.test.ts
it('六種線型都有樣式定義', () => {
  const types: LineType[] = ['cut','crease','halfcut','bleed','annotation','dimension'];
  for (const t of types) expect(LINE_STYLES[t].stroke).toMatch(/^#[0-9A-Fa-f]{6}$/);
});
```

- [ ] **Step 2: 跑紅** → **Step 3: 實作** → **Step 4: 跑綠**
- [ ] **Step 5: Commit** `feat: 型別契約、線型樣式表、盒型 registry 與參數解析`

---

### Task 5: core/primitives.ts — 可複用構件

**Files:**
- Create: `src/core/primitives.ts`
- Test: `tests/core/primitives.test.ts`

**Interfaces:**
- Consumes: `PathBuilder`（T3）、型別（T4）
- Produces（從前身 RTE 的 drawLock/drawRelief/drawDim/drawDimV 抽出並結構化）:
```ts
export const GLUE_CHAMFER = 5;      // 糊邊導角 mm（前身 magic number 具名化）
export const LOCK_HEIGHT = 1.5;     // 摩擦扣凸起高 mm
export const LOCK_CHAMFER = 2;      // 摩擦扣導角 mm
export function frictionLock(xStart: number, xEnd: number, y: number, dir: 'up' | 'down', lockWidth: number):
  { creases: Segment[]; cut: Segment[] };   // lockWidth<=0 時 cut 空、creases 為整段直線（前身行為）
export function reliefSlot(cornerX: number, cornerY: number, side: 'left' | 'right', dir: 'top' | 'bottom', gap: number, notchHeight: number):
  { cut: Segment[]; end: { x: number; y: number } };   // J-Hook 貝茲避讓槽，回傳終點供接續
export function dimensionLine(x1: number, y1: number, x2: number, y2: number, label: string, offset: number, orientation: 'h' | 'v'):
  { paths: Segment[]; text: { x: number; y: number; text: string; rotation: number } };
```

- [ ] **Step 1: 失敗測試**（代表：frictionLock 的 cut 位於中央 lockWidth 範圍且凸起 = LOCK_HEIGHT×dir 符號；lockWidth=0 回整段 crease；reliefSlot 終點座標 = corner±gap 與 corner±notchHeight；dimensionLine 水平/垂直文字位置與旋轉）——每個都以前身 `ReverseTuckEnd.ts:124-165,312-327` 的行為為準（移植保真，非重新設計）。
- [ ] **Step 2-4: 紅→實作→綠**（實作照前身邏輯翻成 Segment 輸出）
- [ ] **Step 5: Commit** `feat: 刀模構件庫（摩擦扣/避讓槽/標註線）`

---

### Task 6: boxes/reverse-tuck-end.ts — RTE 移植

**Files:**
- Create: `src/boxes/reverse-tuck-end.ts`, `tests/fixtures/rte-reference.json`
- Test: `tests/boxes/reverse-tuck-end.test.ts`
- 參照（唯讀）: `/Users/fran/Desktop/trouver.crm-rebuild/components/Tools/Packaging/models/ReverseTuckEnd.ts`

**Interfaces:**
- Consumes: PathBuilder、primitives、types、registry
- Produces: `export const reverseTuckEnd: BoxModule`（meta.id=`'rte'`）；模組載入時自行 `registerBox(reverseTuckEnd)`

**參數宣告**（14 個，全部照前身平移＋教育說明；預設值照前身 UI 預設）：
`L`(55) `W`(55) `D`(117) `thickness`(0.3) `tuckDepth`(12) `tuckRadius`(3) `tuckClearance`(0.5) `tuckLock`(20) `dustFlapDepth`(14) `flapNotch`(3) `creaseRelief`(3) `glueSize`(12) `glueSide`(enum: left|right，前身 glueOnRight 布林改 enum——spec §3.3 S4 修訂)。每參數 `description.zh` 寫一句結構意義（如 tuckDepth:「插舌伸進盒身的深度，決定上蓋抗拉開的力道」）、`highlightTags` 對應前身 tag（'L','W','D','tuckDepth','glueSize','dustFlapDepth','flapNotch','tuckLock'）。

**不變式**（≥4 條）：`unfold-width`（展開總寬＝L+W+L+W+glueSize，對 bounds 驗證＋20 邊距）；`lid-equals-w`（蓋板高＝W）；`no-nan`（hasNaN=false）；`no-bleed`（無 bleed 線型——全盒型通用，可放共用 helper）；`bounds-cover`（bounds 涵蓋全部 segment bounds）。

- [ ] **Step 1: 產 reference fixture（一次性，先於測試）**

在前身 repo 跑（唯讀）：
```bash
cd /Users/fran/Desktop/trouver.crm-rebuild && ./node_modules/.bin/tsx -e "
import { generateReverseTuckEnd } from './components/Tools/Packaging/models/ReverseTuckEnd';
const r = generateReverseTuckEnd({ L:55,W:55,D:117,thickness:0.3,tuckDepth:12,tuckRadius:3,tuckClearance:0.5,tuckLock:20,dustFlapDepth:14,flapNotch:3,creaseRelief:3,glueSize:12,glueOnRight:false } as any);
console.log(JSON.stringify({ paths: r.paths.map(p=>({type:p.type,d:p.d})), bounds: r.bounds }));
" > /Users/fran/projects/open-dieline/tests/fixtures/rte-reference.json
```
Expected: JSON 檔含 42 paths（前身實測值：cut 19/crease 14/dimension 9）。

- [ ] **Step 2: 失敗測試**

```ts
import referenceRaw from '../fixtures/rte-reference.json';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { normalizeSegments } from '@/core/geometry';

it('等價驗證：與前身輸出在 normalized Segment 層一致（spec §4.1）', () => {
  const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
  const ours = normalizeSegments(result.paths.filter(p => p.type !== 'dimension').flatMap(p => p.segments));
  const reference = normalizeSegments(parseReferenceDStrings(referenceRaw));  // 測試檔內 helper：parse M/L/A d 字串→Segment（前身 d 只含這三種指令）
  expect(ours).toEqual(reference);
});

it('假旋鈕：每個參數取第二有效值都改變輸出（spec §8）', () => {
  const base = normalizeSegments(gen({}).paths.flatMap(p => p.segments));
  for (const p of reverseTuckEnd.params) {
    const alt = p.unit === 'bool' ? !(p.default as boolean)
      : p.unit === 'enum' ? p.options!.find(o => o.value !== p.default)!.value
      : Math.min((p.max ?? 999), (p.default as number) + Math.max(p.step ?? 1, 1));
    const out = normalizeSegments(gen({ [p.key]: alt }).paths.flatMap(s => s.segments));
    expect(out, `參數 ${p.key} 未接線`).not.toEqual(base);
  }
});

it('全部不變式在預設參數下通過', () => {
  const params = resolveParams(reverseTuckEnd);
  const result = reverseTuckEnd.generate(params);
  for (const inv of reverseTuckEnd.invariants)
    expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
});

it('golden 快照', () => {
  const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
  expect(normalizeSegments(result.paths.flatMap(p => p.segments))).toMatchSnapshot();
});
```

注意：等價比對排除 dimension 線（前身標註線含文字定位微差可接受；主幾何 cut/crease 必須全等）。若排除後仍有正當差異（如前身 bug 修正），逐條在測試註解記錄原因並調整 reference——**不許無說明的差異**。

- [ ] **Step 3: 跑紅** → **Step 4: 移植實作**

照前身 `ReverseTuckEnd.ts` 逐段翻譯：座標鏈 x0–x4／糊邊（用 GLUE_CHAMFER）／frictionLock、reliefSlot、dimensionLine 改呼叫 primitives／頂部與底部週界的鏡像重複抽成 `perimeter(side: 'top'|'bottom')` 內部函式（上下差異＝蓋板在 P3(top)/P1(bottom)、方向符號）。輸出經 PathBuilder 產 Segment。

- [ ] **Step 5: 跑綠**（含 snapshot 首次生成）
- [ ] **Step 6: Commit** `feat: RTE 反插盒移植（等價驗證+假旋鈕+不變式+golden）`

---

### Task 7: export/svg.ts — SVG 匯出（與畫布同源）

**Files:**
- Create: `src/export/svg.ts`
- Test: `tests/export/svg.test.ts`

**Interfaces:**
- Consumes: GenerateResult、LINE_STYLES、segmentsToSvgD
- Produces:
```ts
export function toSvgDocument(result: GenerateResult, opts?: { includeDimensions?: boolean }): string;
// 完整 SVG 文件字串：width/height 以 mm 明示（bounds 尺寸）、viewBox=bounds、
// 每 DielinePath 一個 <path d=… stroke=… …>（樣式值來自 LINE_STYLES——禁止字面色碼）、
// texts 轉 <text>；includeDimensions=false 時剔除 dimension/annotation 線與文字
```

- [ ] **Step 1: 失敗測試**（代表：輸出含 `width="…mm"`；cut path 的 stroke 等於 `LINE_STYLES.cut.stroke`（從模組讀，不寫死）；includeDimensions=false 後無 dimension path；**樣式同源 mutation 測試**——`vi.spyOn`/mock LINE_STYLES.cut.stroke 改值後輸出跟著變）
- [ ] **Step 2-4: 紅→實作→綠**
- [ ] **Step 5: Commit** `feat: SVG 匯出（樣式與畫布同源）`

---

### Task 8: UI — App/Canvas/ParamPanel/ExportBar

**Files:**
- Create: `src/ui/App.tsx`(重寫佔位), `src/ui/Canvas.tsx`, `src/ui/ParamPanel.tsx`, `src/ui/ExportBar.tsx`, `src/ui/useParams.ts`
- Test: `tests/ui/app.test.tsx`（冒煙）
- 參照（唯讀，流程外觀依據）: 前身 `Packaging/index.tsx`（深色工程風、左欄參數/右畫布、pan/zoom 操作）

**Interfaces:**
- Consumes: registry（listBoxes/getBox/resolveParams）、GenerateResult、LINE_STYLES、segmentsToSvgD、toSvgDocument
- Produces:
  - `useParams(boxId)` hook：`{ values: ResolvedParams, setValue(key, v), reset() }`——內部以「使用者覆寫集」＋`resolveParams(mod, overrides)` 實作，**未覆寫欄位的 derivedDefault 即時重算**（顯示值＝生成值，spec §3.3）
  - Canvas props：`{ result: GenerateResult; highlightTags: string[] | null; invariantWarnings: {message: LocalizedText; tags?: string[]}[] }`
  - ParamPanel 以 `param.group.zh` 分組渲染；hover 參數 → 回呼 `onHighlight(param.highlightTags)`

**UI 行為規格**（照前身流程外觀）：
- 佈局：左側 320px 深色參數欄（群組標題＋輸入列）＋右側畫布區
- Canvas：`scale` state＋`pan` state、滾輪縮放、拖曳平移、Fit 按鈕（依 bounds 算初始 scale）——邏輯照前身 `index.tsx:100-122` 手刻模式移植
- 線段渲染：每 DielinePath → `<path d={segmentsToSvgD(p.segments)} style={LINE_STYLES[p.type]}/>`；被 highlight 的 path 疊加亮色描邊（`stroke:#FF6B00; strokeWidth×3; opacity 0.9`）
- 不變式警告：params 或 result 變更時跑全部 `invariants.check`，not-ok 顯示畫布頂部紅條（message.zh）＋高亮其 tags
- ExportBar：「下載 SVG」按鈕（`toSvgDocument` → Blob 下載，檔名 `rte-{L}x{W}x{D}.svg`）、「含尺寸標註」checkbox

- [ ] **Step 1: 冒煙測試（先寫）**

```tsx
it('起站→選 RTE→調 L→畫布 path 數不變且幾何改變', async () => {
  render(<App />);
  expect(await screen.findByText('open-dieline')).toBeInTheDocument();
  const before = document.querySelectorAll('svg path').length;
  const input = screen.getByLabelText(/長.*L/);
  fireEvent.change(input, { target: { value: '80' } });
  expect(document.querySelectorAll('svg path').length).toBe(before);  // path 數不因 L 改變
});
it('不變式 not-ok 顯示警告條', () => { /* 用測試盒型（fake registry entry）注入必敗 invariant，驗警告條文字 */ });
```

- [ ] **Step 2: 紅** → **Step 3: 實作**（元件拆分如上；`InputGroup` 定義在模組層級，不在 render 內——前身反模式修正）
- [ ] **Step 4: 綠＋手動驗證** Run: `npm run dev` → 瀏覽器操作：調參即時更新、hover 高亮、縮放平移、下載 SVG 開啟正常
- [ ] **Step 5: Commit** `feat: 參數面板（schema 生成）+ 畫布 + SVG 下載`

---

### Task 9: 樣張 gate（法蘭驗收）🚪

**Files:** 無新檔——驗收活動

- [ ] **Step 1:** `npm run dev`，請法蘭實際操作 RTE：
  1. 調 L/W/D 與插舌參數，畫布即時性與手感（對照舊工具）
  2. hover 參數 → 幾何高亮是否直覺
  3. 下載 SVG，用 Illustrator/瀏覽器開啟比對畫布
  4. 把參數調到極端（tuckLock > 面板寬）看不變式警告是否出現且看得懂
- [ ] **Step 2:** 收集反饋。UI 手感/佈局問題在本 gate 修完才進 Slice 2（overlay/天地盒的 UI 都疊在這層地基上）
- [ ] **Step 3:** gate 過 → 更新任務夾 index 與 HANDOFF，撰寫 Slice 2 plan（天地盒量測表流程先行）

---

## Self-Review 紀錄（撰寫時已跑）

1. **Spec 覆蓋**：Slice 1 對應 spec §3（全）、§4.1（全）、§6.1（全）、§8（RTE 相關全部）、§10 驗收 1/2/4(SVG 半)/8；§4.2/§5/§6.2/§7/§9/§10 其餘＝Slice 2+（plan 頭部已聲明）。無遺漏。
2. **Placeholder 掃描**：無 TBD/TODO；「另補案例」均附具體斷言清單。
3. **型別一致性**：`ResolvedParams`/`GenerateResult`/`normalizeSegments`/`segmentsToSvgD`/`LINE_STYLES` 於 T2-T8 簽章一致；T6 的 `glueSide` enum 與 T4 的 `unit:'enum'`+`options` 對齊（前身 `glueOnRight` 布林在 fixture 產生命令中仍用前身介面——正確，那是前身的 API）。
