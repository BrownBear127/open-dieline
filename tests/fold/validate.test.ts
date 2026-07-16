import { describe, expect, it } from 'vitest';
import type { FoldModel } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

function validModel(): FoldModel {
  const polygon = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  return {
    panels: [
      { id: 'root', polygon: structuredClone(polygon), parent: null, foldAngle: 0 },
      {
        id: 'side-a',
        polygon: structuredClone(polygon),
        parent: 'root',
        hingeLine: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
        foldAngle: Math.PI / 2,
        liftOffset: 1,
      },
      {
        id: 'side-b',
        polygon: structuredClone(polygon),
        parent: 'root',
        hingeLine: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
        foldAngle: -Math.PI / 2,
      },
    ],
    steps: [
      { panelIds: ['side-a'], t0: 0, t1: 0.5, ease: 'linear' },
      { panelIds: ['side-b'], t0: 0.5, t1: 1, ease: 'powerInOut' },
    ],
  };
}

function errorText(model: FoldModel): string {
  return validateFoldModel(model).join('\n').toLowerCase();
}

describe('validateFoldModel', () => {
  it('accepts a valid model', () => {
    expect(validateFoldModel(validModel())).toEqual([]);
  });

  it('rejects duplicate panel ids', () => {
    const model = validModel();
    model.panels[2]!.id = 'side-a';

    const errors = errorText(model);
    expect(errors).toContain('duplicate panel id');
    expect(errors).toContain('side-a');
  });

  it('requires exactly one root', () => {
    const model = validModel();
    model.panels[0]!.parent = 'side-a';

    expect(errorText(model)).toContain('exactly one root');
  });

  it('requires the root foldAngle to be zero', () => {
    const model = validModel();
    model.panels[0]!.foldAngle = 0.25;

    const errors = errorText(model);
    expect(errors).toContain('root');
    expect(errors).toContain('foldangle');
  });

  it('rejects a missing parent reference', () => {
    const model = validModel();
    model.panels[1]!.parent = 'missing-parent';

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('missing-parent');
  });

  it('rejects a self-parent reference', () => {
    const model = validModel();
    model.panels[1]!.parent = 'side-a';

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('self-parent');
  });

  it('finds a disconnected B-C cycle even when a valid root exists', () => {
    const model = validModel();
    model.panels[1]!.parent = 'side-b';
    model.panels[2]!.parent = 'side-a';

    const errors = errorText(model);
    expect(errors).toContain('cycle');
    expect(errors).toContain('side-a');
    expect(errors).toContain('side-b');
  });

  it('requires every non-root panel to have a hingeLine', () => {
    const model = validModel();
    delete model.panels[1]!.hingeLine;

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('hingeline');
  });

  it('requires both hingeLine endpoints to lie on a parent polygon edge', () => {
    const model = validModel();
    model.panels[1]!.hingeLine = { a: { x: 2, y: 2 }, b: { x: 8, y: 2 } };

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('parent "root"');
    expect(errors).toContain('endpoint');
  });

  it('rejects hingeLine endpoints that lie on different parent edges', () => {
    const model = validModel();
    model.panels[1]!.polygon = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    model.panels[1]!.hingeLine = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } };

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('single edge of parent "root"');
  });

  it('rejects a detached child whose polygon does not contain the hinge segment', () => {
    const model = validModel();
    model.panels[1]!.polygon = [
      { x: 20, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 30 },
      { x: 20, y: 30 },
    ];
    model.panels[1]!.hingeLine = { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } };

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('single edge of child polygon');
  });

  it('rejects a hinge whose endpoints hit collinear parent edges but whose middle crosses a gap', () => {
    const model = validModel();
    model.panels[0]!.polygon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    model.panels[1]!.polygon = [
      { x: 1, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 1 },
      { x: 1, y: 1 },
    ];
    model.panels[1]!.hingeLine = { a: { x: 1, y: 0 }, b: { x: 9, y: 0 } };

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('single edge of parent "root"');
  });

  it('accepts hingeLine endpoints less than 1e-6 from a parent edge', () => {
    const model = validModel();
    model.panels[1]!.hingeLine = {
      a: { x: 2, y: 0.0000005 },
      b: { x: 8, y: 0.0000005 },
    };

    expect(validateFoldModel(model)).toEqual([]);
  });

  it('rejects hingeLine endpoints exactly 1e-6 from a parent edge', () => {
    const model = validModel();
    model.panels[1]!.hingeLine = {
      a: { x: 2, y: 0.000001 },
      b: { x: 8, y: 0.000001 },
    };

    expect(errorText(model)).toContain('side-a');
  });

  it('rejects a step panel reference that does not exist', () => {
    const model = validModel();
    model.steps[0]!.panelIds = ['ghost'];

    const errors = errorText(model);
    expect(errors).toContain('step 0');
    expect(errors).toContain('ghost');
  });

  it('rejects duplicate panel ids within one step', () => {
    const model = validModel();
    model.steps[0]!.panelIds = ['side-a', 'side-a'];

    const errors = errorText(model);
    expect(errors).toContain('step 0');
    expect(errors).toContain('duplicate');
    expect(errors).toContain('side-a');
  });

  it('requires every non-root panel to belong to a step', () => {
    const model = validModel();
    model.steps[0]!.panelIds = [];

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('0 steps');
  });

  it('rejects a non-root panel assigned to multiple steps', () => {
    const model = validModel();
    model.steps[1]!.panelIds.push('side-a');

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('2 steps');
  });

  it('rejects a non-zero liftOffset on a panel that has a child', () => {
    const model = validModel();
    model.panels[2]!.parent = 'side-a';

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('liftoffset');
    expect(errors).toContain('child');
  });

  it('rejects a root assigned to a step', () => {
    const model = validModel();
    model.steps[0]!.panelIds.push('root');

    const errors = errorText(model);
    expect(errors).toContain('root');
    expect(errors).toContain('must not belong');
  });

  it.each([
    ['negative t0', -0.1, 0.5],
    ['equal t0 and t1', 0.5, 0.5],
    ['t0 after t1', 0.75, 0.5],
    ['t1 above one', 0.5, 1.1],
  ])('rejects invalid step timing: %s', (_label, t0, t1) => {
    const model = validModel();
    model.steps[0]!.t0 = t0;
    model.steps[0]!.t1 = t1;

    const errors = errorText(model);
    expect(errors).toContain('step 0');
    expect(errors).toContain('0 <= t0 < t1 <= 1');
  });

  it.each([
    {
      label: 'foldAngle',
      id: 'side-a',
      mutate: (model: FoldModel) => { model.panels[1]!.foldAngle = Number.POSITIVE_INFINITY; },
    },
    {
      label: 'liftOffset',
      id: 'side-a',
      mutate: (model: FoldModel) => { model.panels[1]!.liftOffset = Number.NaN; },
    },
    {
      label: 'polygon coordinate',
      id: 'side-a',
      mutate: (model: FoldModel) => { model.panels[1]!.polygon[0]!.x = Number.NEGATIVE_INFINITY; },
    },
    {
      label: 'hingeLine coordinate',
      id: 'side-a',
      mutate: (model: FoldModel) => { model.panels[1]!.hingeLine!.a.y = Number.NaN; },
    },
    {
      label: 't0',
      id: 'step 0',
      mutate: (model: FoldModel) => { model.steps[0]!.t0 = Number.NaN; },
    },
    {
      label: 't1',
      id: 'step 0',
      mutate: (model: FoldModel) => { model.steps[0]!.t1 = Number.POSITIVE_INFINITY; },
    },
  ])('rejects a non-finite $label', ({ id, mutate }) => {
    const model = validModel();
    mutate(model);

    const errors = errorText(model);
    expect(errors).toContain(id);
    expect(errors).toContain('finite');
  });

  it('requires at least three polygon vertices', () => {
    const model = validModel();
    model.panels[1]!.polygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }];

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('at least 3 vertices');
  });

  it.each([
    ['zero area', [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]],
    ['negative signed area', [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]],
  ])('requires positive polygon area: %s', (_label, polygon) => {
    const model = validModel();
    model.panels[1]!.polygon = polygon;

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('positive area');
  });

  it('requires hingeLine length to be greater than zero', () => {
    const model = validModel();
    model.panels[1]!.hingeLine = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };

    const errors = errorText(model);
    expect(errors).toContain('side-a');
    expect(errors).toContain('length');
  });

  it('reports multiple independent errors instead of returning early', () => {
    const model = validModel();
    model.panels[2]!.id = 'side-a';
    model.steps[0]!.t1 = model.steps[0]!.t0;

    const errors = validateFoldModel(model);
    const text = errors.join('\n').toLowerCase();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('duplicate panel id');
    expect(text).toContain('0 <= t0 < t1 <= 1');
  });
});
