// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import { FoldView, type ArtworkFileLoader } from '@/ui/FoldView';
import { artworkLayoutSignature, hashArtworkLayoutSignature } from '@/ui/artwork-layout';
import type {
  ArtworkAlignmentMetadata,
  CustomArtworkSource,
  FoldSceneHandle,
  FoldSceneOptions,
  createFoldScene,
} from '@/ui/fold-scene';

const RTE_VALUES = resolveParams(reverseTuckEnd, {});
const TTB_VALUES = resolveParams(triangularTube, {});

interface FakeScene {
  createScene: typeof createFoldScene;
  handles: FoldSceneHandle[];
  options: FoldSceneOptions[];
}

function createFakeScene(): FakeScene {
  const handles: FoldSceneHandle[] = [];
  const options: FoldSceneOptions[] = [];
  const createScene = vi.fn((_canvas: HTMLCanvasElement, nextOptions: FoldSceneOptions = {}) => {
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
    handles.push(handle);
    options.push(nextOptions);
    return handle;
  });

  return { createScene, handles, options };
}

function artworkSignature(values: ResolvedParams = RTE_VALUES): string {
  return artworkLayoutSignature(buildRteFoldModel(values));
}

function customSource(signature = artworkSignature()): CustomArtworkSource {
  return { canvas: document.createElement('canvas'), signature };
}

// 切盒型測試要跟目前盒型的真實 model signature 相符（不然會誤觸「不同的、既有」
// 事後 param-drift staleTemplate 偵測——那是本測試不驗證的獨立機制）。
function ttbArtworkSignature(values: ResolvedParams = TTB_VALUES): string {
  return artworkLayoutSignature(buildTtbFoldModel(values));
}

// 警示不再由 loadArtworkFile 的回傳值「凍結」，
// 而是原樣掛在 CustomArtworkSource.alignmentMetadata 上，FoldView 每次 render 都拿
// 「當下」boxId／layout signature 對這份 metadata 重新求值——測試因此要在 source
// 上帶 metadata，而非只在 mock 回傳值裡塞 warnings（那個回傳值只是「上傳當下」的
// 一次性快照，FoldView 已不讀它來決定顯示）。
function customSourceWithMetadata(
  metadata: Partial<ArtworkAlignmentMetadata>,
  signature = artworkSignature(),
): CustomArtworkSource {
  return {
    canvas: document.createElement('canvas'),
    signature,
    alignmentMetadata: { boxId: null, layoutHash: null, aspectMismatch: false, ...metadata },
  };
}

function installTimerBackedAnimationFrame() {
  let timestamp = 0;
  const request = vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => {
    timestamp += 16;
    callback(timestamp);
  }, 16));
  const cancel = vi.fn((id: number) => window.clearTimeout(id));
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return { request, cancel };
}

beforeEach(() => {
  setLang('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLang('en');
  vi.restoreAllMocks();
});

describe('FoldView controls', () => {
  it('renders the two-column dict-labelled foldbar controls with the required vocabulary classes', async () => {
    const fake = createFakeScene();
    const { container } = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );

    const controls = await screen.findByRole('group', { name: t('fold.controls.aria') });
    const play = within(controls).getByRole('button', { name: t('fold.play') });
    const progress = within(controls).getByRole('slider', { name: t('fold.progress.aria') });

    expect(controls).toHaveClass('foldbar');
    expect(play).toHaveClass('btn');
    expect(within(controls).getAllByRole('button')).toEqual([play]);
    expect(controls.children).toHaveLength(2);
    expect(progress).toHaveAttribute('type', 'range');
    expect(progress).toHaveAttribute('min', '0');
    expect(progress).toHaveAttribute('max', '1');
    expect(progress).toHaveAttribute('step', '0.001');
    expect(progress).toHaveValue('1');
    expect(container.querySelector('.foldbar')).toBe(controls);
  });

  it('renders the owner-approved floating button stack between the canvas and foldbar', async () => {
    const fake = createFakeScene();
    const { container } = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );

    const cardGroup = await screen.findByRole('group', { name: t('fold.card.label') });
    const artworkGroup = screen.getByRole('group', { name: t('fold.art.label') });
    const tools = container.querySelector('.fold-tools');
    const autoRotate = screen.getByRole('button', { name: t('fold.autorotate') });

    expect(tools).not.toBeNull();
    expect(cardGroup).toHaveClass('fold-tool-group');
    expect(artworkGroup).toHaveClass('fold-tool-group');
    // M4 T5：CARD 3＋ART 4（SAMPLE/TEMPLATE/UPLOAD/EDIT）＋AUTO-ROTATE 1。
    expect(within(tools as HTMLElement).getAllByRole('button')).toHaveLength(8);
    expect(within(artworkGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual([
        t('fold.art.sample'),
        t('fold.art.template'),
        t('fold.art.upload'),
        t('fold.art.edit'),
      ]);
    expect(autoRotate).toHaveClass('btn', 'tog', 'label');
    expect(autoRotate).toHaveAttribute('aria-pressed', 'false');
    // 自轉預設關閉：進場靜止、由使用者主動開啟。
    expect(container.querySelector('.fold-canvas')?.nextElementSibling).toBe(tools);
    expect(tools?.nextElementSibling).toBe(container.querySelector('.foldbar'));
  });

  it('renders three card recipes with kraft as the only pressed option', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);

    const cardGroup = await screen.findByRole('group', { name: t('fold.card.label') });
    const buttons = within(cardGroup).getAllByRole('button');

    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.textContent)).toEqual([
      t('fold.card.white'),
      t('fold.card.kraft'),
      t('fold.card.black'),
    ]);
    for (const button of buttons) expect(button).toHaveClass('btn', 'tog', 'label');
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true'))
      .toEqual([within(cardGroup).getByRole('button', { name: t('fold.card.kraft') })]);
  });

  it('applies the clicked card recipe and transfers the single pressed state', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const cardGroup = screen.getByRole('group', { name: t('fold.card.label') });
    const black = within(cardGroup).getByRole('button', { name: t('fold.card.black') });

    fireEvent.click(black);

    expect(fake.handles[0]!.applyRecipe).toHaveBeenCalledExactlyOnceWith('black');
    expect(black).toHaveAttribute('aria-pressed', 'true');
    expect(within(cardGroup).getByRole('button', { name: t('fold.card.kraft') }))
      .toHaveAttribute('aria-pressed', 'false');
    expect(within(cardGroup).getAllByRole('button').filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    )).toEqual([black]);
  });

  it('renders the owner-approved zh card copy verbatim', async () => {
    setLang('zh');
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);

    const cardGroup = await screen.findByRole('group', { name: '卡色' });

    expect(within(cardGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['白', '牛皮', '黑']);
  });

  it('defaults SAMPLE off and toggles SAMPLE/NONE through one aria-pressed button', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const artworkGroup = screen.getByRole('group', { name: 'ART' });
    const sample = within(artworkGroup).getByRole('button', { name: 'SAMPLE' });

    expect(sample).toHaveAttribute('aria-pressed', 'false');
    expect(sample).toHaveClass('btn', 'tog', 'label');

    fireEvent.click(sample);
    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('sample');
    expect(sample).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(sample);
    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('none');
    expect(sample).toHaveAttribute('aria-pressed', 'false');
  });

  it('commits an uploaded source, installs it before selecting custom, and keeps SAMPLE mutually exclusive', async () => {
    const fake = createFakeScene();
    const source = customSource();
    const onCustomSourceChange = vi.fn();
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      options.onCommit(source);
      return { status: 'committed', warnings: [] };
    });
    const { container } = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={null}
        onCustomSourceChange={onCustomSourceChange}
        loadArtwork={loadArtwork}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const file = new File(['png'], 'art.png', { type: 'image/png' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const foldView = container.querySelector('.fold-view');

    expect(foldView).toHaveAttribute('data-artwork-ready', 'none');

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onCustomSourceChange).toHaveBeenCalledExactlyOnceWith(source));
    expect(loadArtwork).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({ boxId: 'rte' }));
    expect(fake.handles[0]!.installCustomSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('custom');
    expect(foldView).toHaveAttribute('data-artwork-ready', 'custom');
    const art = screen.getByRole('group', { name: t('fold.art.label') });
    expect(within(art).getByRole('button', { name: t('fold.art.upload') }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(within(art).getByRole('button', { name: t('fold.art.sample') }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('switching custom to SAMPLE disposes the owner source and removes it from the scene', async () => {
    const fake = createFakeScene();
    const source: CustomArtworkSource = {
      canvas: document.createElement('canvas'),
      signature: 'rte:fixture',
    };
    const onCustomSourceChange = vi.fn();
    render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={source}
        onCustomSourceChange={onCustomSourceChange}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));

    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('sample');
    expect(fake.handles[0]!.removeCustomSource).toHaveBeenCalledOnce();
    expect(onCustomSourceChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('UPLOAD toggle-off selects NONE and releases custom source ownership', async () => {
    const fake = createFakeScene();
    const source: CustomArtworkSource = {
      canvas: document.createElement('canvas'),
      signature: 'rte:fixture',
    };
    const onCustomSourceChange = vi.fn();
    render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={source}
        onCustomSourceChange={onCustomSourceChange}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.upload') }));

    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('none');
    expect(fake.handles[0]!.removeCustomSource).toHaveBeenCalledOnce();
    expect(onCustomSourceChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('clears the file input so selecting the same file twice starts two requests', async () => {
    const fake = createFakeScene();
    const loadArtwork = vi.fn<ArtworkFileLoader>(async () => 'cancelled');
    const { container } = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        loadArtwork={loadArtwork}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['png'], 'same.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(loadArtwork).toHaveBeenCalledTimes(2));
  });

  it('marks custom artwork stale after a parameter change, keeps it sticky after revert, and preserves the preview', async () => {
    const fake = createFakeScene();
    const source = customSource();
    const view = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={source}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const artworkCalls = vi.mocked(fake.handles[0]!.applyArtwork).mock.calls.length;

    const changedValues: ResolvedParams = { ...RTE_VALUES, L: (RTE_VALUES.L as number) + 10 };
    view.rerender(
      <FoldView
        boxId="rte"
        values={changedValues}
        createScene={fake.createScene}
        customSource={source}
      />,
    );

    const stale = await screen.findByRole('status');
    expect(stale).toHaveTextContent(t('fold.art.staleTemplate'));
    expect(stale).toHaveClass('fold-status', 'mono');
    expect(stale.closest('.fold-view')).not.toBeNull();
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    expect(fake.handles[0]!.applyArtwork).toHaveBeenCalledTimes(artworkCalls);

    view.rerender(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={source}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(t('fold.art.staleTemplate'));
  });

  it('does not mark matching custom artwork stale for card, progress, autorotate, or camera changes', async () => {
    const fake = createFakeScene();
    render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={customSource()}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: t('fold.card.white') }));
    fireEvent.change(screen.getByRole('slider', { name: t('fold.progress.aria') }), {
      target: { value: '0.4' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('fold.autorotate') }));
    act(() => fake.options[0]!.onUserInteract?.());

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('marks custom artwork stale when paper thickness changes the compensated flat layout', async () => {
    const fake = createFakeScene();
    const source = customSource();
    const view = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        customSource={source}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    view.rerender(
      <FoldView
        boxId="rte"
        values={{ ...RTE_VALUES, thickness: (RTE_VALUES.thickness as number) + 0.1 }}
        createScene={fake.createScene}
        customSource={source}
      />,
    );

    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status')).toHaveTextContent(t('fold.art.staleTemplate'));
  });

  it.each([
    ['NONE', 'upload'],
    ['SAMPLE', 'sample'],
  ] as const)('clears sticky stale when switching to %s', async (_label, target) => {
    const fake = createFakeScene();
    const source = customSource();
    const changedValues: ResolvedParams = { ...RTE_VALUES, W: (RTE_VALUES.W as number) + 5 };
    render(
      <FoldView
        boxId="rte"
        values={changedValues}
        createScene={fake.createScene}
        customSource={source}
      />,
    );
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', {
      name: t(target === 'upload' ? 'fold.art.upload' : 'fold.art.sample'),
    }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears sticky stale after the next successful upload', async () => {
    const fake = createFakeScene();
    const source = customSource();
    const changedValues: ResolvedParams = { ...RTE_VALUES, D: (RTE_VALUES.D as number) + 5 };
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      options.onCommit(customSource(options.signature));
      return { status: 'committed', warnings: [] };
    });
    const { container } = render(
      <FoldView
        boxId="rte"
        values={changedValues}
        createScene={fake.createScene}
        customSource={source}
        loadArtwork={loadArtwork}
      />,
    );
    await screen.findByRole('status');

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['png'], 'fresh.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(loadArtwork).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(loadArtwork).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ signature: artworkSignature(changedValues) }),
    );
  });

  it('shows a dict-backed DOM alert for a structured rejection and keeps the previous mode', async () => {
    const fake = createFakeScene();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const loadArtwork = vi.fn<ArtworkFileLoader>(async () => ({ code: 'type' }));
    const { container } = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        loadArtwork={loadArtwork}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const sample = screen.getByRole('button', { name: t('fold.art.sample') });
    fireEvent.click(sample);

    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['bad'], 'bad.txt', { type: 'text/plain' })] },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('fold.art.invalidFile'));
    expect(alert).toHaveClass('fold-status', 'mono');
    expect(alert.closest('.fold-view')).not.toBeNull();
    expect(sample).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: t('fold.art.upload') }))
      .toHaveAttribute('aria-pressed', 'false');
    expect(getContext).not.toHaveBeenCalledWith('2d');
  });

  it('clears an upload error on picker open, successful upload, or mode switch', async () => {
    const fake = createFakeScene();
    let succeeds = false;
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      if (!succeeds) return { code: 'type' };
      options.onCommit(customSource(options.signature));
      return { status: 'committed', warnings: [] };
    });
    const { container } = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        loadArtwork={loadArtwork}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const upload = screen.getByRole('button', { name: t('fold.art.upload') });
    const rejectFile = (): void => {
      fireEvent.change(input, {
        target: { files: [new File(['bad'], 'bad.txt', { type: 'text/plain' })] },
      });
    };

    rejectFile();
    await screen.findByRole('alert');
    fireEvent.click(upload);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rejectFile();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rejectFile();
    await screen.findByRole('alert');
    succeeds = true;
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'fresh.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('aborts an in-flight upload when the artwork mode changes', async () => {
    const fake = createFakeScene();
    let signal: AbortSignal | undefined;
    const loadArtwork = vi.fn<ArtworkFileLoader>((_file, options) => {
      signal = options.signal;
      return new Promise<never>(() => undefined);
    });
    const { container } = render(
      <FoldView
        boxId="rte"
        values={RTE_VALUES}
        createScene={fake.createScene}
        loadArtwork={loadArtwork}
      />,
    );
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(loadArtwork).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));

    expect(signal?.aborted).toBe(true);
    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('sample');
  });

  it('renders the approved English and Chinese artwork copy verbatim', async () => {
    const fake = createFakeScene();
    const view = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );
    const englishGroup = await screen.findByRole('group', { name: 'ART' });
    expect(within(englishGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['SAMPLE', 'TEMPLATE', 'UPLOAD', 'EDIT']);

    view.unmount();
    setLang('zh');
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    const chineseGroup = await screen.findByRole('group', { name: '圖稿' });
    expect(within(chineseGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['範例', '模板', '上傳', '編輯']);
  });

  it('drives the current scene pose from the progress slider without recreating the scene', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    const progress = await screen.findByRole('slider', { name: t('fold.progress.aria') });
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.change(progress, { target: { value: '0.375' } });

    expect(progress).toHaveValue('0.375');
    expect(fake.handles[0]!.updatePose).toHaveBeenLastCalledWith(0.375);
    expect(fake.createScene).toHaveBeenCalledOnce();
    expect(fake.handles[0]!.dispose).not.toHaveBeenCalled();
  });

  it('replays from zero, advances linearly, and stops at one without recreating the scene', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const initialPoseCalls = vi.mocked(fake.handles[0]!.updatePose).mock.calls.length;

    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    fireEvent.click(screen.getByRole('button', { name: t('fold.play') }));

    expect(screen.getByRole('button', { name: t('fold.pause') })).toBeInTheDocument();
    expect(vi.mocked(fake.handles[0]!.updatePose).mock.calls.slice(initialPoseCalls)[0]).toEqual([0]);

    await act(async () => vi.advanceTimersByTimeAsync(1_216));
    const midpoint = Number(screen.getByRole('slider', { name: t('fold.progress.aria') }).getAttribute('value'));
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_300));
    expect(screen.getByRole('slider', { name: t('fold.progress.aria') })).toHaveValue('1');
    expect(screen.getByRole('button', { name: t('fold.play') })).toBeInTheDocument();
    expect(fake.handles[0]!.updatePose).toHaveBeenLastCalledWith(1);
    expect(fake.createScene).toHaveBeenCalledOnce();
    expect(fake.handles[0]!.dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses playback and jumps to the requested value when the slider is dragged', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    fireEvent.click(screen.getByRole('button', { name: t('fold.play') }));
    const progress = screen.getByRole('slider', { name: t('fold.progress.aria') });
    fireEvent.change(progress, { target: { value: '0.625' } });

    expect(screen.getByRole('button', { name: t('fold.play') })).toBeInTheDocument();
    expect(progress).toHaveValue('0.625');
    expect(fake.handles[0]!.updatePose).toHaveBeenLastCalledWith(0.625);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts with auto-rotate off on mount and forwards both button states', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    const autoRotate = await screen.findByRole('button', { name: t('fold.autorotate') });
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    expect(fake.handles[0]!.setAutoRotate).toHaveBeenCalledExactlyOnceWith(false);
    expect(autoRotate).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(autoRotate);
    expect(fake.handles[0]!.setAutoRotate).toHaveBeenLastCalledWith(true);
    expect(autoRotate).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(autoRotate);
    expect(fake.handles[0]!.setAutoRotate).toHaveBeenLastCalledWith(false);
    expect(autoRotate).toHaveAttribute('aria-pressed', 'false');
  });

  it('cancels the playback frame and leaves no timer when unmounted', async () => {
    const fake = createFakeScene();
    const view = render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    const animationFrame = installTimerBackedAnimationFrame();
    fireEvent.click(screen.getByRole('button', { name: t('fold.play') }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(animationFrame.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not render controls for unsupported and WebGL fallback states', async () => {
    const fake = createFakeScene();
    const unsupported = render(<FoldView boxId="telescope" values={{}} createScene={fake.createScene} />);
    expect(await screen.findByText(t('fold.unsupported'))).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: t('fold.controls.aria') })).not.toBeInTheDocument();
    unsupported.unmount();

    const loadScene = vi.fn<() => Promise<{ createFoldScene: typeof createFoldScene }>>();
    render(<FoldView boxId="rte" values={RTE_VALUES} loadScene={loadScene} />);
    expect(await screen.findByText(t('fold.webglUnavailable'))).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: t('fold.controls.aria') })).not.toBeInTheDocument();
  });

  it('renders EDIT disabled for telescope while retaining the unsupported preview', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="telescope" values={{}} createScene={fake.createScene} />);

    expect(await screen.findByText(t('fold.unsupported'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('fold.art.edit') })).toBeDisabled();
    expect(fake.createScene).not.toHaveBeenCalled();
  });

  it('使用者拖轉（onUserInteract）後自轉按鈕同步關閉、可手動重開（final review F3）', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    // 預設關閉——先由使用者開啟自轉，才有「拖轉即停」可驗。
    const autoRotate = screen.getByRole('button', { name: t('fold.autorotate') });
    expect(autoRotate).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(autoRotate);
    expect(autoRotate).toHaveAttribute('aria-pressed', 'true');

    // fold-scene 在 controls start 事件已自行關 autoRotate 並回呼 onUserInteract——
    // FoldView state 必須跟上，否則按鈕謊報開啟
    act(() => fake.options[0]!.onUserInteract?.());
    expect(autoRotate).toHaveAttribute('aria-pressed', 'false');

    // 手動重開走按鈕 → scene.setAutoRotate(true)
    fireEvent.click(autoRotate);
    expect(autoRotate).toHaveAttribute('aria-pressed', 'true');
    expect(fake.handles[0]!.setAutoRotate).toHaveBeenLastCalledWith(true);
  });

  // 上傳對位 guard-rail：警示不阻擋 commit（warn-and-apply），顯示於既有
  // status 列。stale-template 借用既有 fold.art.staleTemplate 文案（同語意），
  // box-mismatch／aspect 各自有新文案。
  // 警示不是上傳當下凍結的字串——metadata 掛在 source 上，FoldView 每次 render
  // 都拿「當下」boxId／layout signature 重新求值，故測試用 customSourceWithMetadata
  // 讓 source 帶 metadata，而不是靠 mock 回傳值裡的 warnings 陣列驅動顯示。
  describe('artwork alignment warnings（warn-and-apply＋動態重算）', () => {
    function loaderCommitting(source: CustomArtworkSource) {
      return vi.fn<ArtworkFileLoader>(async (_file, options) => {
        options.onCommit(source);
        return { status: 'committed', warnings: [] };
      });
    }

    it('box-mismatch 警示：commit 照常發生，status 列顯示對應文案', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ boxId: 'ttb' });
      const loadArtwork = loaderCommitting(source);
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
      });

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(t('fold.art.warning.boxMismatch'));
      expect(container.querySelector('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
    });

    it('aspect 警示：commit 照常發生，status 列顯示對應文案', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ aspectMismatch: true });
      const loadArtwork = loaderCommitting(source);
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
      });

      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.warning.aspect'));
    });

    it('stale-template 警示借用既有 fold.art.staleTemplate 文案（同語意，不重複定義）', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ layoutHash: 'deadbeef' });
      const loadArtwork = loaderCommitting(source);
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
      });

      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.staleTemplate'));
    });

    it('多個警示同時成立時只顯示最高優先的一條（box-mismatch > stale-template > aspect）', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ layoutHash: 'deadbeef', aspectMismatch: true });
      const loadArtwork = loaderCommitting(source);
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
      });

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(t('fold.art.staleTemplate'));
      expect(status).not.toHaveTextContent(t('fold.art.warning.aspect'));
    });

    it('切換到 SAMPLE/NONE 會清除警示（同既有 staleTemplate 的清除慣例）', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ boxId: 'ttb' });
      const loadArtwork = loaderCommitting(source);
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
      });
      await screen.findByRole('status');

      fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('下一次成功上傳且無警示時，舊警示不殘留', async () => {
      const fake = createFakeScene();
      const warned = customSourceWithMetadata({ boxId: 'ttb' });
      const clean = customSourceWithMetadata({});
      let nextSource = warned;
      const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
        options.onCommit(nextSource);
        return { status: 'committed', warnings: [] };
      });
      const { container } = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} loadArtwork={loadArtwork} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['png'], 'a.png', { type: 'image/png' })] } });
      await screen.findByRole('status');

      nextSource = clean;
      fireEvent.change(input, { target: { files: [new File(['png'], 'b.png', { type: 'image/png' })] } });

      await waitFor(() => expect(loadArtwork).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    // 核心不變量：警示不凍結在上傳當下，跟著「當下」boxId／參數動態重算。
    it('上傳時對位盒型與目前相同（不警示），事後切換盒型才動態出現 box-mismatch，切回去又消失', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ boxId: 'rte' });
      const view = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      view.rerender(
        <FoldView boxId="ttb" values={TTB_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.warning.boxMismatch'));

      view.rerender(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      // 切回去後 box-mismatch 必須動態消失（核心不變量：不凍結在上傳當下）。
      // 不斷言「完全無 status」——來回切換盒型必然也改變 model signature，會連帶
      // 觸發既有、獨立的「事後改參數」staleTemplate sticky 偵測（該機制獨立於本測試，
      // 其 sticky 行為在別的既有測試已驗證是刻意設計），兩者互不相關、各自對錯。
      await waitFor(() => expect(screen.queryByText(t('fold.art.warning.boxMismatch'))).not.toBeInTheDocument());
    });

    it('上傳後改參數才動態出現 stale-template（metadata.layoutHash 對「上傳當下」的 hash，不對新 hash）', async () => {
      const fake = createFakeScene();
      const uploadHash = hashArtworkLayoutSignature(artworkSignature(RTE_VALUES));
      const source = customSourceWithMetadata({ layoutHash: uploadHash }, artworkSignature(RTE_VALUES));
      const view = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      const changedValues: ResolvedParams = { ...RTE_VALUES, L: (RTE_VALUES.L as number) + 10 };
      view.rerender(
        <FoldView boxId="rte" values={changedValues} createScene={fake.createScene} customSource={source} />,
      );

      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.staleTemplate'));
    });

    it('DESIGN→FOLD 往返（卸載＋重掛載）後，metadata 隨 customSource 一起持久化，警示仍能正確重算（非侷限本地 state）', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ boxId: 'ttb' }, ttbArtworkSignature());
      const view = render(
        <FoldView boxId="ttb" values={TTB_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      expect(screen.queryByRole('status')).not.toBeInTheDocument();

      // 模擬 App 層 DESIGN→FOLD 往返：FoldView 整個卸載又重新掛載（同一個 customSource
      // 物件由父層持久化並原樣傳回——這正是既有「retained custom artwork」測試證明過的
      // 提升機制；alignmentMetadata 隨同一個物件一起活下來，不需要額外的 lift-up 管線）。
      view.unmount();
      render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} customSource={source} />,
      );

      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.warning.boxMismatch'));
    });

    // 上傳「無 data-layout-hash 但 aspect 異常」的
    // 檔案時只有 aspect 警示（metadata.boxId／layoutHash 皆 null）。之後改參數觸發
    // 既有「事後改參數」sticky staleTemplate 偵測——這顆偵測跟 metadata 系統本是兩條
    // 獨立管線，若各自佔一層優先序（金字塔式互相蓋壓），aspect 那一層若排在
    // staleTemplate 那層之上，sticky 觸發後畫面仍卡在 aspect 文案，違反
    // box-mismatch > stale-template > aspect 的規格優先序（sticky 情境下
    // stale-template 應該贏過 aspect）。兩者併入同一份 warnings 陣列一起排序。
    it('aspect 警示顯示中，之後改參數觸發 sticky staleTemplate → 優先序切換顯示 stale-template（非卡在 aspect）', async () => {
      const fake = createFakeScene();
      const source = customSourceWithMetadata({ aspectMismatch: true });
      const view = render(
        <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} customSource={source} />,
      );
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
      expect(await screen.findByRole('status')).toHaveTextContent(t('fold.art.warning.aspect'));

      const changedValues: ResolvedParams = { ...RTE_VALUES, L: (RTE_VALUES.L as number) + 10 };
      view.rerender(
        <FoldView boxId="rte" values={changedValues} createScene={fake.createScene} customSource={source} />,
      );

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(t('fold.art.staleTemplate'));
      expect(status).not.toHaveTextContent(t('fold.art.warning.aspect'));
    });
  });
});
