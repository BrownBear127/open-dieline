import type { ResolvedParams } from '../core/types';
import { buildRteFoldModel } from './models/reverse-tuck-end';
import { buildTelescopeSceneSpec } from './models/telescope';
import { buildTtbFoldModel } from './models/triangular-tube';
import { buildTtslFoldModel } from './models/tuck-top-snap-lock';
import {
  defineFoldSceneSpec,
  type FoldScenePiece,
  type FoldSceneSpec,
} from './scene-spec';
import type { FoldWorldUp } from './world-orientation';

export interface FoldCapabilities {
  previewScene: boolean;
  sampleArtwork: boolean;
  template: boolean;
  upload: boolean;
  editor: boolean;
}

export interface FoldSceneRegistryEntry {
  worldUp: FoldWorldUp;
  capabilities: FoldCapabilities;
  sceneSpec?: (params: ResolvedParams) => FoldSceneSpec;
}

export const FOLD_SCENE_REGISTRY: Record<string, FoldSceneRegistryEntry> =
  Object.create(null) as Record<string, FoldSceneRegistryEntry>;

export function registerFoldScene(
  boxId: string,
  entry: FoldSceneRegistryEntry,
): void {
  if (entry.worldUp !== 'tube' && entry.worldUp !== 'tray') {
    throw new Error(
      `registerFoldScene "${boxId}": worldUp must be "tube" or "tray"`,
    );
  }
  const { previewScene } = entry.capabilities;
  const hasSceneSpec = entry.sceneSpec !== undefined;
  if (previewScene && !hasSceneSpec) {
    throw new Error(
      `registerFoldScene "${boxId}": previewScene=true requires sceneSpec`,
    );
  }
  if (!previewScene && hasSceneSpec) {
    throw new Error(
      `registerFoldScene "${boxId}": sceneSpec is invalid when previewScene=false`,
    );
  }
  if (Object.hasOwn(FOLD_SCENE_REGISTRY, boxId)) {
    throw new Error(`registerFoldScene "${boxId}": box id is already registered`);
  }

  const buildSceneSpec = entry.sceneSpec;
  FOLD_SCENE_REGISTRY[boxId] = {
    worldUp: entry.worldUp,
    capabilities: { ...entry.capabilities },
    ...(buildSceneSpec === undefined
      ? {}
      : {
        sceneSpec: (params: ResolvedParams) =>
          defineFoldSceneSpec(buildSceneSpec(params)),
      }),
  };
}

const FULL_CAPABILITIES: FoldCapabilities = {
  previewScene: true,
  sampleArtwork: true,
  template: true,
  upload: true,
  editor: true,
};

function registerSinglePiece(
  boxId: string,
  buildModel: FoldScenePiece['buildModel'],
): void {
  registerFoldScene(boxId, {
    worldUp: 'tube',
    capabilities: FULL_CAPABILITIES,
    sceneSpec: () => ({
      pieces: [{
        pieceId: boxId,
        buildModel,
        foldWindow: [0, 1],
        assemblyTrack: [],
      }],
    }),
  });
}

registerSinglePiece('rte', buildRteFoldModel);
registerSinglePiece('ttsl', buildTtslFoldModel);
registerSinglePiece('ttb', buildTtbFoldModel);

registerFoldScene('telescope', {
  worldUp: 'tray',
  capabilities: {
    previewScene: true,
    sampleArtwork: false,
    template: false,
    upload: false,
    editor: false,
  },
  sceneSpec: buildTelescopeSceneSpec,
});
