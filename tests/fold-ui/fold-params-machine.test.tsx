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

type ModelProjection = (model: FoldModel) => unknown;

interface ParamCase {
  key: string;
  value: number | string;
  dimension: string;
  project: ModelProjection;
}

const PARAM_CASES: ParamCase[] = [
  { key: 'L', value: 65, dimension: 'P1 width', project: (model) => panelWidth(model, 'P1') },
  { key: 'W', value: 65, dimension: 'P2 width and lid height', project: (model) => [panelWidth(model, 'P2'), panelHeight(model, 'topLid')] },
  { key: 'D', value: 127, dimension: 'P1 height', project: (model) => panelHeight(model, 'P1') },
  { key: 'thickness', value: 0.6, dimension: 'tuck liftOffset', project: (model) => [panel(model, 'topTuck').liftOffset, panel(model, 'bottomTuck').liftOffset] },
  { key: 'tuckDepth', value: 0, dimension: 'tuck panel count and active steps', project: (model) => [model.panels.map(({ id }) => id), model.steps] },
  { key: 'tuckRadius', value: 0, dimension: 'tuck polygon coordinates', project: (model) => panel(model, 'topTuck').polygon },
  { key: 'tuckClearance', value: 5, dimension: 'tuck polygon width', project: (model) => [panelWidth(model, 'topTuck'), panelWidth(model, 'bottomTuck')] },
  { key: 'tuckLock', value: 0, dimension: 'lid polygons and active steps', project: (model) => [panel(model, 'topLid').polygon, panel(model, 'bottomLid').polygon, model.steps] },
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

  // tuckLock 暫不驗區分性（BLOCKED-ON-法蘭 2026-07-17）：2D frictionLock 的摺線本身分裂
  //（crease 斷成 [xStart..xLeft]+[xRight..xEnd]、蓋板梯形凸片跨越摺線），validate 的
  // 單邊含中點規則（polygonEdgeContainsSegment）在原理上無法表達分裂 hinge；放寬規則＝
  // M0 核心不變式變更。證明與候選方案見 ledger progress-p3-m1.md；裁決後 todo 轉真測試
  //（區分維度視表示法裁決而定——蓋板梯形凸片或插舌基邊缺口）。
  it.todo('tuckLock changes the received model dimension — BLOCKED-ON-法蘭（validator 單邊含中點規則 vs 2D 分裂 crease）');

  it.each(PARAM_CASES.filter(({ key }) => key !== 'tuckLock'))('$key changes the received model dimension: $dimension', async ({ key, value, project }) => {
    const fake = createFakeScene();
    const defaults = resolveParams(reverseTuckEnd, {});
    const view = render(<FoldView boxId="rte" values={defaults} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const defaultModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[0]![0];

    const changed = resolveParams(reverseTuckEnd, { [key]: value });
    view.rerender(<FoldView boxId="rte" values={changed} createScene={fake.createScene} />);
    await waitFor(() => expect(fake.handles[0]!.replaceModel).toHaveBeenCalledTimes(2));
    const changedModel = vi.mocked(fake.handles[0]!.replaceModel).mock.calls[1]![0];

    expect(project(changedModel)).not.toEqual(project(defaultModel));
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
});
