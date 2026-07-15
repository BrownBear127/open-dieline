/**
 * A2 匯出基線（Spec §10 A2）：改版前 main 生成的 SVG/DXF 必須逐 byte 不變。
 * 生成模式：BASELINE_WRITE=1 npm test -- baseline（僅 M0 T1/T2 各跑一次，之後禁止）。
 * 比對模式（預設）：讀檔案＋驗 manifest sha256 雙鎖——vitest -u 動不了它，
 * 改基線唯一路徑=改 manifest（顯性、可 review）。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { GenerateResult } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { toSvgDocument } from '@/export/svg';
import { toDxfDocument } from '@/export/dxf';

const DIR = path.resolve(__dirname, '../baselines/export');
const MANIFEST = path.join(DIR, 'manifest.json');
const WRITE = process.env.BASELINE_WRITE === '1';

/** 合成 fixture：覆蓋全部 6 種 LineType＋line/arc 兩種 segment＋texts（C2：真盒型湊不齊全類） */
function syntheticAllTypes(): GenerateResult {
  return {
    paths: [
      { id: 's-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 50, y2: 0 }] },
      { id: 's-crease', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 10, x2: 50, y2: 10 }] },
      { id: 's-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 20, x2: 50, y2: 20 }] },
      { id: 's-bleed', type: 'bleed', segments: [{ kind: 'line', x1: 0, y1: 30, x2: 50, y2: 30 }] },
      { id: 's-annotation', type: 'annotation', segments: [{ kind: 'line', x1: 0, y1: 40, x2: 50, y2: 40 }] },
      {
        id: 's-dimension', type: 'dimension',
        segments: [
          { kind: 'line', x1: 0, y1: 50, x2: 40, y2: 50 },
          { kind: 'arc', cx: 45, cy: 50, r: 5, startAngle: 0, endAngle: 90, ccw: false },
        ],
      },
    ],
    texts: [{ id: 't-0', x: 25, y: 55, text: '50.00', anchor: 'middle' }],
    bounds: { minX: 0, maxX: 50, minY: 0, maxY: 60 },
  };
}

const CASES: Array<{ name: string; make: () => GenerateResult }> = [
  { name: 'rte-default', make: () => reverseTuckEnd.generate(resolveParams(reverseTuckEnd)) },
  { name: 'telescope-default', make: () => telescope.generate(resolveParams(telescope)) },
  { name: 'synthetic-all-types', make: syntheticAllTypes },
];

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

function artifacts(name: string, r: GenerateResult): Record<string, string> {
  return {
    [`${name}.svg`]: toSvgDocument(r),
    [`${name}.manufacturing.svg`]: toSvgDocument(r, { manufacturing: true }),
    [`${name}.dxf`]: toDxfDocument(r),
  };
}

describe('A2 匯出基線 byte-identical', () => {
  if (WRITE) {
    it('生成基線（僅 M0 一次）', () => {
      mkdirSync(DIR, { recursive: true });
      const existing = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { files: {} };
      const files: Record<string, string> = { ...existing.files };
      for (const c of CASES) {
        for (const [fname, content] of Object.entries(artifacts(c.name, c.make()))) {
          writeFileSync(path.join(DIR, fname), content);
          files[fname] = sha256(content);
        }
      }
      const commit = execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '../..') }).toString().trim();
      writeFileSync(MANIFEST, JSON.stringify({ generatedAtCommit: commit, files }, null, 2) + '\n');
      expect(Object.keys(files).length).toBeGreaterThan(0);
    });
    return;
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { generatedAtCommit: string; files: Record<string, string> };

  for (const c of CASES) {
    it(`${c.name}：SVG（一般＋manufacturing）與 DXF 逐 byte 等於基線`, () => {
      for (const [fname, content] of Object.entries(artifacts(c.name, c.make()))) {
        const baseline = readFileSync(path.join(DIR, fname), 'utf8');
        // 雙鎖：檔案內容=當前輸出，且檔案 hash=manifest 記錄（防基線檔被順手改）
        expect(sha256(baseline)).toBe(manifest.files[fname]);
        expect(content).toBe(baseline);
      }
    });
  }
});
