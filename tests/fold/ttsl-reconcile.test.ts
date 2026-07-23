// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { DielinePath } from '@/core/types';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';

const RECONCILE_MATRIX = [
  { label: 'default', overrides: {} },
  { label: 'zero thickness/left glue', overrides: { thickness: 0, glueSide: 'left' } },
  { label: 'zero thickness/right glue', overrides: { thickness: 0, glueSide: 'right' } },
  { label: 'max thickness/left glue', overrides: { thickness: 0.8, glueSide: 'left' } },
  { label: 'max thickness/right glue', overrides: { thickness: 0.8, glueSide: 'right' } },
] as const;

function hasActiveSegment(path: DielinePath): boolean {
  const inactive = new Set(path.inactiveSegments ?? []);
  return path.segments.some((_, index) => !inactive.has(index));
}

describe('TTSL generate → panelize reconciliation', () => {
  for (const { label, overrides } of RECONCILE_MATRIX) {
    it(`${label}: every active fold role is represented by exactly one derived child`, () => {
      const params = resolveParams(tuckTopSnapLock, overrides);
      const generated = tuckTopSnapLock.generate(params);
      const model = buildTtslFoldModel(params);
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
      const params = resolveParams(tuckTopSnapLock, overrides);
      const generated = tuckTopSnapLock.generate(params);
      const model = buildTtslFoldModel(params);
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

    it(`${label}: reconciled identity uses only the single receiving-panel contract`, () => {
      const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, overrides));
      const ids = model.panels.map(({ id }) => id);
      expect(ids).toContain('bottomReceiveP3');
      expect(ids.some((id) => /^bottomReceiveP3\./.test(id))).toBe(false);
      expect(model.steps.flatMap(({ panelIds }) => panelIds)).toContain('bottomReceiveP3');
    });
  }
});
