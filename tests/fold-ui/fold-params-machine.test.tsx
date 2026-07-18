import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel, FoldPanel } from '@/fold/types';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import { FoldView } from '@/ui/FoldView';
import type { FoldSceneHandle, FoldSceneOptions, createFoldScene } from '@/ui/fold-scene';

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

function panel(model: FoldModel, id: string): FoldPanel {
  const target = model.panels.find((candidate) => candidate.id === id);
  expect(target, `missing panel ${id}`).toBeDefined();
  return target!;
}

function panelWidth(model: FoldModel, id: string): number {
  const xs = panel(model, id).polygon.map(({ x }) => x);
  return Math.max(...xs) - Math.min(...xs);
}

function panelHeight(model: FoldModel, id: string): number {
  const ys = panel(model, id).polygon.map(({ y }) => y);
  return Math.max(...ys) - Math.min(...ys);
}

type ReplaceModelOptions = Parameters<FoldSceneHandle['replaceModel']>[1];
type ModelProjection = (model: FoldModel, options: ReplaceModelOptions) => unknown;

interface ParamCase {
  key: string;
  value: number | string;
  dimension: string;
  project: ModelProjection;
}

const PARAM_CASES: ParamCase[] = [
  { key: 'L', value: 65, dimension: 'P1 width', project: (model) => panelWidth(model, 'P1') },
  { key: 'W', value: 65, dimension: 'P2 width and lid height', project: (model) => [panelWidth(model, 'P2'), panelHeight(model, 'topLidC')] },
  { key: 'D', value: 127, dimension: 'P1 height', project: (model) => panelHeight(model, 'P1') },
  { key: 'thickness', value: 0.6, dimension: 'renderer thickness', project: (_model, options) => options?.thickness },
  { key: 'tuckDepth', value: 0, dimension: 'tuck panel count and active steps', project: (model) => [model.panels.map(({ id }) => id), model.steps] },
  { key: 'tuckRadius', value: 0, dimension: 'tuck polygon coordinates', project: (model) => panel(model, 'topTuck').polygon },
  { key: 'tuckClearance', value: 5, dimension: 'tuck polygon width', project: (model) => [panelWidth(model, 'topTuck'), panelWidth(model, 'bottomTuck')] },
  {
    key: 'tuckLock',
    value: 12,
    dimension: 'lid-slice hinge spans and friction-lock vertices',
    project: (model) => [
      panel(model, 'topLidL').hingeLine,
      panel(model, 'topLidL').polygon,
      panel(model, 'bottomLidR').hingeLine,
      panel(model, 'bottomLidR').polygon,
    ],
  },
  { key: 'dustFlapDepth', value: 0, dimension: 'dust panel count and active steps', project: (model) => [model.panels.map(({ id }) => id), model.steps] },
  { key: 'flapNotch', value: 10, dimension: 'dust-flap polygon coordinates', project: (model) => [panel(model, 'topDustP2').polygon, panel(model, 'topDustP4').polygon] },
  { key: 'creaseRelief', value: 10, dimension: 'dust-flap relief polygon coordinates', project: (model) => [panel(model, 'bottomDustP2').polygon, panel(model, 'bottomDustP4').polygon] },
  { key: 'glueSize', value: 20, dimension: 'glue panel width', project: (model) => panelWidth(model, 'glue') },
  { key: 'glueSide', value: 'right', dimension: 'glue parent and polygon coordinates', project: (model) => [panel(model, 'glue').parent, panel(model, 'glue').polygon] },
];

beforeEach(() => {
  setLang('en');
});

afterEach(() => {
  cleanup();
  setLang('en');
  vi.restoreAllMocks();
});

describe('FoldView B4-machine parameter linkage', () => {
  it('covers the exact 13 geometry-affecting RTE parameter keys', () => {
    expect(PARAM_CASES.map(({ key }) => key)).toEqual(reverseTuckEnd.params.map(({ key }) => key));
  });

  it.each(PARAM_CASES)('$key changes the received model dimension: $dimension', async ({ key, value, project }) => {
    const fake = createFakeScene();
    const defaults = resolveParams(reverseTuckEnd, {});
    const view = render(<FoldView boxId="rte" values={defaults} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const [defaultModel, defaultOptions] = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[0]!;

    const changed = resolveParams(reverseTuckEnd, { [key]: value });
    view.rerender(<FoldView boxId="rte" values={changed} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    const [changedModel, changedOptions] = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[1]!;

    expect(project(changedModel, changedOptions)).not.toEqual(project(defaultModel, defaultOptions));
    expect(fake.createScene).toHaveBeenCalledOnce();
    expect(fake.handles[0]!.dispose).not.toHaveBeenCalled();
  });

  it('propagates the thickness-derived tuckClearance and distinguishes a manual override', async () => {
    const fake = createFakeScene();
    const derived = resolveParams(reverseTuckEnd, { thickness: 0.6 });
    const overridden = resolveParams(reverseTuckEnd, { thickness: 0.6, tuckClearance: 0.8 });
    expect(derived.tuckClearance).toBe(1.1);
    expect(overridden.tuckClearance).toBe(0.8);

    const view = render(<FoldView boxId="rte" values={derived} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const derivedModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[0]![0];

    view.rerender(<FoldView boxId="rte" values={overridden} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    const overriddenModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[1]![0];

    expect(panel(derivedModel, 'topTuck').polygon).not.toEqual(panel(overriddenModel, 'topTuck').polygon);
    expect(panel(derivedModel, 'bottomTuck').polygon).not.toEqual(panel(overriddenModel, 'bottomTuck').polygon);
  });

  it('replaces the model without resetting the current fold progress', async () => {
    const fake = createFakeScene();
    const defaults = resolveParams(reverseTuckEnd, {});
    const view = render(<FoldView boxId="rte" values={defaults} createScene={fake.createScene} />);
    const progress = await screen.findByRole('slider', { name: t('fold.progress.aria') });
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.change(progress, { target: { value: '0.42' } });
    expect(fake.handles[0]!.updatePose).toHaveBeenLastCalledWith(0.42);
    const poseCallCount = vi.mocked(fake.handles[0]!.updatePose).mock.calls.length;

    const changed: ResolvedParams = resolveParams(reverseTuckEnd, { L: 65 });
    view.rerender(<FoldView boxId="rte" values={changed} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));

    expect(vi.mocked(fake.handles[0]!.updatePose).mock.calls).toHaveLength(poseCallCount);
    expect(fake.handles[0]!.updatePose).toHaveBeenLastCalledWith(0.42);
    expect(screen.getByRole('slider', { name: t('fold.progress.aria') })).toHaveValue('0.42');
  });

  it('keeps SAMPLE active and shows no stale status after a dimension change', async () => {
    const fake = createFakeScene();
    const defaults = resolveParams(reverseTuckEnd, {});
    const view = render(<FoldView boxId="rte" values={defaults} createScene={fake.createScene} />);
    const sample = await screen.findByRole('button', { name: t('fold.art.sample') });
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());

    fireEvent.click(sample);
    expect(fake.handles[0]!.applyArtwork).toHaveBeenLastCalledWith('sample');
    expect(view.container.querySelector('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');

    view.rerender(
      <FoldView
        boxId="rte"
        values={resolveParams(reverseTuckEnd, { L: 65 })}
        createScene={fake.createScene}
      />,
    );
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));

    expect(view.container.querySelector('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');
    expect(screen.queryByText(t('fold.art.staleTemplate'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('editor.stale'))).not.toBeInTheDocument();
  });
});
