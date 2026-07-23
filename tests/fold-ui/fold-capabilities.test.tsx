import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { registerFoldScene } from '@/fold/registry';
import { defineFoldSceneSpec } from '@/fold/scene-spec';
import { t } from '@/i18n/t';
import { FoldView } from '@/ui/FoldView';
import type { FoldSceneHandle, createFoldScene } from '@/ui/fold-scene';

const PREVIEW_ONLY_ID = '__preview-only-capability-test';
const VALUES = resolveParams(reverseTuckEnd, {});

registerFoldScene(PREVIEW_ONLY_ID, {
  capabilities: {
    previewScene: true,
    sampleArtwork: false,
    template: false,
    upload: false,
    editor: false,
  },
  sceneSpec: () => defineFoldSceneSpec({
    pieces: [{
      pieceId: PREVIEW_ONLY_ID,
      buildModel: buildRteFoldModel,
      foldWindow: [0, 1],
      assemblyTrack: [],
    }],
  }),
});

afterAll(() => {
  cleanup();
});

describe('FoldView atomic capability consumption', () => {
  it('creates a preview while keeping EDIT disabled when previewScene and editor differ', async () => {
    const handle: FoldSceneHandle = {
      updatePose: vi.fn(),
      replaceModel: vi.fn(),
      setAutoRotate: vi.fn(),
      applyRecipe: vi.fn(),
      applyArtwork: vi.fn(),
      installCustomSource: vi.fn(),
      removeCustomSource: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    const createScene = vi.fn<typeof createFoldScene>(() => handle);
    const customSource = {
      canvas: document.createElement('canvas'),
      signature: 'must-not-enter-preview-only-scene',
    };

    render(
      <FoldView
        boxId={PREVIEW_ONLY_ID}
        values={VALUES}
        createScene={createScene}
        customSource={customSource}
      />,
    );

    await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: t('fold.art.edit') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('fold.art.sample') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('fold.art.template') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('fold.art.upload') })).toBeDisabled();
    expect(screen.queryByText(t('fold.unsupported'))).not.toBeInTheDocument();
    expect(handle.replaceModel).toHaveBeenCalledOnce();
    expect(handle.installCustomSource).not.toHaveBeenCalled();
    expect(handle.applyArtwork).not.toHaveBeenCalledWith('custom');
  });
});
