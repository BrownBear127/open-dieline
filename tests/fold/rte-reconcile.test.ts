// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import type { DielinePath } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';

const RECONCILE_MATRIX = [
  { label: 'default', overrides: {} },
  { label: 'tuckDepth=0', overrides: { tuckDepth: 0 } },
  { label: 'tuckLock=0', overrides: { tuckLock: 0 } },
  { label: 'dustFlapDepth=0', overrides: { dustFlapDepth: 0 } },
  { label: 'L=20/clearance=10/t=0', overrides: { L: 20, tuckClearance: 10, thickness: 0 } },
  { label: 'L=20/clearance=10/default t', overrides: { L: 20, tuckClearance: 10 } },
  { label: 'tuckRadius clamp', overrides: { L: 20, tuckClearance: 9, tuckRadius: 15 } },
  { label: 'left glue/max thickness', overrides: { glueSide: 'left', thickness: 0.8 } },
  { label: 'right glue/max thickness', overrides: { glueSide: 'right', thickness: 0.8 } },
] as const;

function hasActiveSegment(path: DielinePath): boolean {
  const inactive = new Set(path.inactiveSegments ?? []);
  return path.segments.some((_, index) => !inactive.has(index));
}

describe('RTE generate → panelize reconciliation', () => {
  for (const { label, overrides } of RECONCILE_MATRIX) {
    it(`${label}: every active fold role is represented by exactly one derived child`, () => {
      const params = resolveParams(reverseTuckEnd, overrides);
      const generated = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const pathsById = new Map(generated.paths.map((path) => [path.id, path]));

      const roleEntries = generated.paths
        .filter((path) => path.type === 'crease' && hasActiveSegment(path))
        .flatMap((path) => (path.tags ?? [])
          .filter((tag) => tag.startsWith('fold:'))
          .map((tag) => ({ pathId: path.id, tag })));

      expect(new Set(roleEntries.map(({ tag }) => tag)).size).toBe(roleEntries.length);
      for (const { tag } of roleEntries) {
        const match = /^fold:([^>]+)>([^>]+)$/.exec(tag);
        expect(match, tag).not.toBeNull();
        const [, parentId, childId] = match!;
        const child = model.panels.find(({ id }) => id === childId);
        const sourceIds = roleEntries
          .filter((entry) => entry.tag === tag)
          .map(({ pathId: sourcePathId }) => sourcePathId)
          .sort();
        expect(child, `missing child for ${tag}`).toBeDefined();
        expect(child!.parent).toBe(parentId);
        expect(child!.hingeSourceCreaseIds).toEqual(sourceIds);
      }

      for (const child of model.panels.filter(({ parent }) => parent !== null)) {
        expect(child.hingeSourceCreaseIds?.length, child.id).toBeGreaterThan(0);
        for (const pathId of child.hingeSourceCreaseIds ?? []) {
          const source = pathsById.get(pathId);
          expect(source, `${child.id}: missing source path ${pathId}`).toBeDefined();
          expect(source!.type).toBe('crease');
          expect(source!.tags).toContain(`fold:${child.parent}>${child.id}`);
          expect(hasActiveSegment(source!)).toBe(true);
        }
      }
    });

    it(`${label}: derived seams retain active cut provenance and valid owners`, () => {
      const params = resolveParams(reverseTuckEnd, overrides);
      const generated = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const pathsById = new Map(generated.paths.map((path) => [path.id, path]));
      const panelIds = new Set(model.panels.map(({ id }) => id));

      for (const seam of model.seams ?? []) {
        const source = pathsById.get(seam.sourcePathId);
        expect(source, seam.sourcePathId).toBeDefined();
        expect(source!.type).toBe('cut');
        expect(hasActiveSegment(source!)).toBe(true);
        expect(panelIds.has(seam.ownerPanelId), seam.ownerPanelId).toBe(true);
        expect(seam.points.length).toBeGreaterThanOrEqual(2);
      }
    });

    it(`${label}: reconciled identity uses only the single-lid contract`, () => {
      const model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
      const ids = model.panels.map(({ id }) => id);
      expect(ids).toContain('topLid');
      expect(ids).toContain('bottomLid');
      expect(ids.some((id) => /(?:top|bottom)Lid[LCR]$/.test(id))).toBe(false);
    });
  }
});
