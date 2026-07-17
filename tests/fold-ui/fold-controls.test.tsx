import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import { FoldView } from '@/ui/FoldView';
import type {
  FoldSceneHandle,
  FoldSceneOptions,
  createFoldScene,
} from '@/ui/fold-scene';

const RTE_VALUES = resolveParams(reverseTuckEnd, {});

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
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    handles.push(handle);
    options.push(nextOptions);
    return handle;
  });

  return { createScene, handles, options };
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
    // M3：CARD 3＋ART 3（SAMPLE/TEMPLATE/UPLOAD）＋AUTO-ROTATE 1。
    expect(within(tools as HTMLElement).getAllByRole('button')).toHaveLength(7);
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

  it('renders the approved English and Chinese artwork copy verbatim', async () => {
    const fake = createFakeScene();
    const view = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );
    const englishGroup = await screen.findByRole('group', { name: 'ART' });
    expect(within(englishGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['SAMPLE', 'TEMPLATE', 'UPLOAD']);

    view.unmount();
    setLang('zh');
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
    const chineseGroup = await screen.findByRole('group', { name: '圖稿' });
    expect(within(chineseGroup).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['範例', '模板', '上傳']);
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
});
