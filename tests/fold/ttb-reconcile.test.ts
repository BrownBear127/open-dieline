// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import type { DielinePath } from '@/core/types';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';

const RECONCILE_MATRIX = [
  { label: 'default', overrides: {} },
  { label: 'shortest tube', overrides: { tubeLength: 82.998 } },
  { label: 'minimum tab width', overrides: { tabWidth: 30 } },
] as const;

function hasActiveSegment(path: DielinePath): boolean {
  const inactive = new Set(path.inactiveSegments ?? []);
  return path.segments.some((_, index) => !inactive.has(index));
}

describe('TTB generate → panelize reconciliation', () => {
  for (const { label, overrides } of RECONCILE_MATRIX) {
    it(`${label}: every active fold role is represented by exactly one derived child`, () => {
      const params = resolveParams(triangularTube, overrides);
      const generated = triangularTube.generate(params);
      const model = buildTtbFoldModel(params);
      const pathsById = new Map(generated.paths.map((path) => [path.id, path]));
      const roleEntries = generated.paths
        .filter((path) => path.type === 'crease' && hasActiveSegment(path))
        .flatMap((path) => (path.tags ?? [])
          .filter((tag) => tag.startsWith('fold:'))
          .map((tag) => ({ pathId: path.id, tag })));
      const roleTags = new Set(roleEntries.map(({ tag }) => tag));

      const sourceBackedChildren = model.panels.filter((panel) =>
        panel.parent !== null && panel.hingeLine?.virtual !== true);
      expect(sourceBackedChildren).toHaveLength(roleTags.size);
      expect(model.panels.filter(({ hingeLine }) => hingeLine?.virtual === true)).toEqual([
        expect.objectContaining({ id: 'zoneDLip', parent: 'zoneDBase' }),
      ]);
      for (const tag of roleTags) {
        const match = /^fold:([^>]+)>([^>]+)$/.exec(tag);
        expect(match, tag).not.toBeNull();
        const [, parentId, childId] = match!;
        const child = model.panels.find(({ id }) => id === childId);
        const sourceIds = roleEntries
          .filter((entry) => entry.tag === tag)
          .map(({ pathId }) => pathId)
          .sort();
        expect(child, `missing child for ${tag}`).toBeDefined();
        expect(child!.parent).toBe(childId === 'zoneDTab' ? 'zoneDLip' : parentId);
        expect(child!.hingeSourceCreaseIds).toEqual(sourceIds);
      }

      for (const child of sourceBackedChildren) {
        expect(child.hingeSourceCreaseIds?.length, child.id).toBeGreaterThan(0);
        for (const pathId of child.hingeSourceCreaseIds ?? []) {
          const source = pathsById.get(pathId);
          expect(source, `${child.id}: missing source path ${pathId}`).toBeDefined();
          expect(source!.type).toBe('crease');
          const sourceParent = child.id === 'zoneDTab' ? 'zoneDBase' : child.parent;
          expect(source!.tags).toContain(`fold:${sourceParent}>${child.id}`);
          expect(hasActiveSegment(source!)).toBe(true);
        }
      }
    });

    it(`${label}: derived seams retain active cut provenance and valid owners`, () => {
      const params = resolveParams(triangularTube, overrides);
      const generated = triangularTube.generate(params);
      const model = buildTtbFoldModel(params);
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

    it(`${label}: lip 區的 Zone D seams 改由 zoneDLip 擁有`, () => {
      const params = resolveParams(triangularTube, overrides);
      const model = buildTtbFoldModel(params);
      const splitY = 4 * (params.edgeA as number) + 4;
      const lipOwned = (model.seams ?? []).filter(({ ownerPanelId }) => ownerPanelId === 'zoneDLip');

      expect(lipOwned.length).toBeGreaterThan(0);
      for (const seam of lipOwned) {
        expect(seam.points.every(({ y }) => y >= splitY - 1e-6), seam.sourcePathId).toBe(true);
      }
      for (const seam of (model.seams ?? []).filter(({ ownerPanelId }) => ownerPanelId === 'zoneDBase')) {
        expect(seam.points.every(({ y }) => y <= splitY + 1e-6), seam.sourcePathId).toBe(true);
      }
    });

    it(`${label}: reconciled identity uses only the single-tab contract`, () => {
      const model = buildTtbFoldModel(resolveParams(triangularTube, overrides));
      const ids = model.panels.map(({ id }) => id);
      expect(ids).toContain('zoneDTab');
      expect(ids.some((id) => id.startsWith('zoneDTab.'))).toBe(false);
      expect(model.steps.flatMap(({ panelIds }) => panelIds)).toContain('zoneDTab');
    });
  }
});
