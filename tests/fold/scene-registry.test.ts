import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import {
  FOLD_SCENE_REGISTRY,
  registerFoldScene,
  type FoldCapabilities,
  type FoldSceneRegistryEntry,
} from '@/fold/registry';
import { defineFoldSceneSpec } from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';

const EMPTY_MODEL: FoldModel = {
  panels: [],
  steps: [],
  dieline: [],
};

const NO_CAPABILITIES: FoldCapabilities = {
  previewScene: false,
  sampleArtwork: false,
  template: false,
  upload: false,
  editor: false,
};

function sceneEntry(
  capabilities: FoldCapabilities,
  withSceneSpec: boolean,
): FoldSceneRegistryEntry {
  return {
    capabilities,
    sceneSpec: withSceneSpec
      ? () => defineFoldSceneSpec({
        pieces: [{
          pieceId: 'piece',
          buildModel: () => EMPTY_MODEL,
          foldWindow: [0, 1],
          assemblyTrack: [],
        }],
      })
      : undefined,
  };
}

describe('Fold scene capability registry', () => {
  it.each([
    ['rte', reverseTuckEnd],
    ['ttsl', tuckTopSnapLock],
    ['ttb', triangularTube],
  ] as const)('wraps %s as one fully capable scene piece', (boxId, box) => {
    const entry = FOLD_SCENE_REGISTRY[boxId];
    expect(entry?.capabilities).toEqual({
      previewScene: true,
      sampleArtwork: true,
      template: true,
      upload: true,
      editor: true,
    });

    const params = resolveParams(box, {});
    const spec = entry!.sceneSpec!(params);
    expect(spec.pieces).toHaveLength(1);
    expect(spec.pieces[0]).toMatchObject({
      pieceId: boxId,
      foldWindow: [0, 1],
      assemblyTrack: [],
    });
    expect(spec.pieces[0]!.buildModel(params).panels.length).toBeGreaterThan(0);
  });

  it('does not register telescope before T8', () => {
    expect(FOLD_SCENE_REGISTRY.telescope).toBeUndefined();
  });

  it('fails loud when previewScene=true has no sceneSpec', () => {
    expect(() => registerFoldScene(
      '__invalid-missing-scene',
      sceneEntry({ ...NO_CAPABILITIES, previewScene: true }, false),
    )).toThrow(/previewScene=true.*sceneSpec/);
  });

  it('fails loud when sceneSpec exists while previewScene=false', () => {
    expect(() => registerFoldScene(
      '__invalid-extra-scene',
      sceneEntry(NO_CAPABILITIES, true),
    )).toThrow(/sceneSpec.*previewScene=false/);
  });

  it('validates every registered sceneSpec result at build time', () => {
    const boxId = '__invalid-window-on-build';
    registerFoldScene(boxId, {
      capabilities: { ...NO_CAPABILITIES, previewScene: true },
      sceneSpec: () => ({
        pieces: [{
          pieceId: 'piece',
          buildModel: () => EMPTY_MODEL,
          foldWindow: [0.5, 0.5],
          assemblyTrack: [],
        }],
      }),
    });

    expect(() => FOLD_SCENE_REGISTRY[boxId]!.sceneSpec!({}))
      .toThrow(/foldWindow/);
  });
});
