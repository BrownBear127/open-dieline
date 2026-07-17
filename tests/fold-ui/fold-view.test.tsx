import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedParams } from '@/core/types';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import { App } from '@/ui/App';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { FoldView } from '@/ui/FoldView';
import type { FoldSceneHandle, FoldSceneOptions, createFoldScene } from '@/ui/fold-scene';

const RTE_VALUES = Object.fromEntries(
  reverseTuckEnd.params.map((param) => [param.key, param.default]),
) as ResolvedParams;

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

beforeEach(() => {
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
  setLang('en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  setLang('en');
  vi.restoreAllMocks();
});

describe('App fold mode', () => {
  it('renders three exclusive mode buttons and switches FOLD back to DESIGN', async () => {
    render(<App />);

    const modes = screen.getByRole('group', { name: t('chrome.modeSwitch.aria') });
    const buttons = within(modes).getAllByRole('button');
    const design = within(modes).getByRole('button', { name: t('mode.design') });
    const imposition = within(modes).getByRole('button', { name: t('mode.imposition') });
    const fold = within(modes).getByRole('button', { name: t('mode.fold') });

    expect(buttons).toHaveLength(3);
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([design]);

    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-pressed', 'true');
    expect(design).toHaveAttribute('aria-pressed', 'false');
    expect(imposition).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(design);
    expect(design).toHaveAttribute('aria-pressed', 'true');
    expect(fold).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('FoldView scene lifecycle', () => {
  it('pairs canvas creation and disposal across three visits', async () => {
    const fake = createFakeScene();
    const view = render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);

    for (let visit = 1; visit <= 3; visit += 1) {
      await waitFor(() => expect(view.container.querySelector('canvas')).toBeInTheDocument());
      await waitFor(() => expect(fake.createScene).toHaveBeenCalledTimes(visit));

      view.rerender(<></>);
      expect(fake.handles[visit - 1]!.dispose).toHaveBeenCalledTimes(1);

      if (visit < 3) {
        view.rerender(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);
      }
    }

    expect(fake.createScene).toHaveBeenCalledTimes(3);
    expect(fake.handles.map((handle) => vi.mocked(handle.dispose).mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('starts at fold progress 1', async () => {
    const fake = createFakeScene();
    render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);

    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    expect(fake.handles[0]!.replaceModel).toHaveBeenCalledOnce();
    expect(vi.mocked(fake.handles[0]!.replaceModel).mock.calls[0]![1]).toEqual({
      thickness: RTE_VALUES.thickness,
    });
    expect(fake.handles[0]!.updatePose).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('replaces the model without recreating the scene or resetting fold progress', async () => {
    const fake = createFakeScene();
    const view = render(<FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />);

    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const firstModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[0]![0];
    const changedValues: ResolvedParams = { ...RTE_VALUES, L: (RTE_VALUES.L as number) + 10 };
    view.rerender(<FoldView boxId="rte" values={changedValues} createScene={fake.createScene} />);

    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    const secondModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[1]![0];
    expect(secondModel).not.toBe(firstModel);
    expect(fake.createScene).toHaveBeenCalledOnce();
    expect(fake.handles[0]!.updatePose).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('records context loss and restoration without replacing the canvas or adding copy', async () => {
    const fake = createFakeScene();
    const { container } = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );

    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const foldView = container.querySelector('.fold-view') as HTMLElement;
    const canvas = container.querySelector('canvas');
    expect(foldView).toHaveAttribute('data-context-lost', 'false');

    act(() => fake.options[0]!.onContextLost?.());
    expect(foldView).toHaveAttribute('data-context-lost', 'true');
    expect(container.querySelector('canvas')).toBe(canvas);
    expect(screen.queryByText(t('fold.unsupported'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('fold.webglUnavailable'))).not.toBeInTheDocument();

    act(() => fake.options[0]!.onContextRestored?.());
    expect(foldView).toHaveAttribute('data-context-lost', 'false');
    expect(container.querySelector('canvas')).toBe(canvas);
  });

  it('resizes the scene from the observed fold container', async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class ResizeObserverFake {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverFake);
    const fake = createFakeScene();
    const { container, unmount } = render(
      <FoldView boxId="rte" values={RTE_VALUES} createScene={fake.createScene} />,
    );

    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const foldView = container.querySelector('.fold-view') as HTMLElement;
    expect(observe).toHaveBeenCalledExactlyOnceWith(foldView);

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 640, height: 480 } as DOMRectReadOnly } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(fake.handles[0]!.resize).toHaveBeenCalledExactlyOnceWith(640, 480);

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('FoldView visible failure states', () => {
  it.each([
    ['en', '3D fold preview is not yet available for this box style.'],
    ['zh', '此盒型尚未支援 3D 摺盒預覽。'],
  ] as const)('does not create a scene for an unsupported box in %s', async (lang, copy) => {
    setLang(lang);
    const fake = createFakeScene();
    const { container } = render(
      <FoldView boxId="telescope" values={{}} createScene={fake.createScene} />,
    );

    expect(await screen.findByText(copy)).toHaveClass('mono');
    expect(screen.getByText(copy).parentElement).toHaveClass('fold-empty');
    expect(container.querySelector('canvas')).not.toBeInTheDocument();
    expect(fake.createScene).not.toHaveBeenCalled();
  });

  it('shows the WebGL fallback before loading the real scene when canvas contexts are unavailable', async () => {
    const loadScene = vi.fn<() => Promise<{ createFoldScene: typeof createFoldScene }>>();
    render(<FoldView boxId="rte" values={RTE_VALUES} loadScene={loadScene} />);

    expect(await screen.findByText(t('fold.webglUnavailable'))).toHaveClass('mono');
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('reports invalid models and shows the unsupported state without creating a scene', async () => {
    const fake = createFakeScene();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalidValues: ResolvedParams = { ...RTE_VALUES, L: Number.NaN };
    const { container } = render(
      <FoldView boxId="rte" values={invalidValues} createScene={fake.createScene} />,
    );

    expect(await screen.findByText(t('fold.unsupported'))).toBeInTheDocument();
    await waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(consoleError.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([expect.stringContaining('coordinates must be finite')]),
    );
    expect(container.querySelector('canvas')).not.toBeInTheDocument();
    expect(fake.createScene).not.toHaveBeenCalled();
  });

  it.each([
    ['en', '3D fold preview failed to load. Switch modes to retry.'],
    ['zh', '3D 摺盒預覽載入失敗，切換模式可重試。'],
  ] as const)('fold-scene chunk 載入失敗時以 %s render loadFailed 文案、不留死控制列', async (lang, copy) => {
    setLang(lang);
    // jsdom getContext 天然 null 會先走 WebGL fallback——mock 成 truthy 讓流程進到 loadScene
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadScene = vi.fn(() => Promise.reject(new Error('chunk unavailable')));
    render(<FoldView boxId="rte" values={RTE_VALUES} loadScene={loadScene} />);

    await waitFor(() => expect(loadScene).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-fold-error="true"]')).not.toBeNull());
    const error = document.querySelector('[data-fold-error="true"]') as HTMLElement;
    expect(error).toHaveClass('fold-empty');
    expect(t('fold.loadFailed')).toBe(copy);
    expect(within(error).getByText(t('fold.loadFailed'))).toHaveClass('mono');
    // 失敗態不得殘留任何看似可操作的控制件或 canvas
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });
});
