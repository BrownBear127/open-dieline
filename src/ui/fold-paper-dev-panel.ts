import type { FoldLook, PaperParams } from './fold-scene';

export type FoldLookName = 'plain' | 'kraft' | 'black' | 'engineering';
export type PaperPresetName = 'subtle' | 'standard' | 'coarse';

interface PaperDevPanelOptions {
  host: HTMLElement;
  initialLook: FoldLookName;
  lookPresets: Record<FoldLookName, FoldLook>;
  initialPaper: PaperParams;
  paperPresets: Record<PaperPresetName, PaperParams>;
  onLook: (look: FoldLookName) => void;
  onLookParams: (look: FoldLook) => void;
  onPaper: (params: PaperParams) => void;
}

export interface PaperDevPanelHandle {
  element: HTMLDivElement;
  setLook(look: FoldLookName, params: FoldLook): void;
  setPaper(params: PaperParams): void;
  dispose(): void;
}

type RangeKey = Exclude<keyof PaperParams, 'seed'>;
type LookRangeKey = 'keyIntensity' | 'fillIntensity' | 'ambientIntensity';
type LookColorKey = 'cardColor' | 'keyColor' | 'fillColor';

const RANGE_CONTROLS: ReadonlyArray<{
  key: RangeKey;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'contrast', min: 0, max: 1, step: 0.01 },
  { key: 'roughness', min: 0, max: 1, step: 0.01 },
  { key: 'fiber', min: 0, max: 1, step: 0.01 },
  { key: 'fiberSize', min: 0, max: 1, step: 0.01 },
  { key: 'crumples', min: 0, max: 1, step: 0.01 },
  { key: 'crumpleSize', min: 0, max: 1, step: 0.01 },
  { key: 'folds', min: 0, max: 1, step: 0.01 },
  { key: 'foldCount', min: 1, max: 15, step: 1 },
  { key: 'drops', min: 0, max: 1, step: 0.01 },
  { key: 'fade', min: 0, max: 1, step: 0.01 },
  { key: 'bumpScale', min: 0, max: 0.2, step: 0.001 },
];

const LOOK_NAMES: FoldLookName[] = ['plain', 'kraft', 'black', 'engineering'];
const PAPER_NAMES: PaperPresetName[] = ['subtle', 'standard', 'coarse'];
const REGENERATE_DELAY_MS = 150;
const LOOK_RANGE_CONTROLS: ReadonlyArray<{
  key: LookRangeKey;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'keyIntensity', min: 0, max: 30, step: 0.1 },
  { key: 'fillIntensity', min: 0, max: 30, step: 0.1 },
  { key: 'ambientIntensity', min: 0, max: 3, step: 0.05 },
];
const LOOK_COLOR_CONTROLS: LookColorKey[] = [
  'cardColor',
  'keyColor',
  'fillColor',
];

function style(element: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, values);
}

function colorHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function createPaperDevPanel(
  options: PaperDevPanelOptions,
): PaperDevPanelHandle {
  let activeLookName = options.initialLook;
  let activeLook = { ...options.lookPresets[activeLookName] };
  let activePaper = { ...options.initialPaper };
  let regenerationTimer: number | null = null;

  const element = document.createElement('div');
  style(element, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '10000',
    color: 'Canvas',
    background: 'CanvasText',
    border: '1px solid GrayText',
    borderRadius: '4px',
    padding: '6px',
    font: '11px/1.25 monospace',
    maxHeight: 'calc(100vh - 24px)',
    overflow: 'auto',
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'PAPER';
  toggle.setAttribute('aria-label', 'Toggle paper controls');
  toggle.setAttribute('aria-expanded', 'true');
  style(toggle, { cursor: 'pointer', font: 'inherit' });
  element.append(toggle);

  const controls = document.createElement('div');
  controls.dataset.paperControls = '';
  style(controls, { width: '300px', paddingTop: '6px' });
  element.append(controls);

  const lookButtons = new Map<FoldLookName, HTMLButtonElement>();
  const lookRangeInputs = new Map<LookRangeKey, HTMLInputElement>();
  const lookColorInputs = new Map<LookColorKey, HTMLInputElement>();
  const inputs = new Map<keyof PaperParams, HTMLInputElement>();

  const createButtonRow = (title: string): HTMLDivElement => {
    const row = document.createElement('div');
    style(row, { display: 'flex', gap: '4px', marginBottom: '6px' });
    const label = document.createElement('span');
    label.textContent = title;
    style(label, { width: '52px', flex: '0 0 auto' });
    row.append(label);
    controls.append(row);
    return row;
  };

  const appendLabeledInput = (
    key: string,
    input: HTMLInputElement,
    marginBottom: string,
  ): void => {
    const label = document.createElement('label');
    style(label, {
      display: 'grid',
      gridTemplateColumns: '132px 1fr',
      gap: '6px',
      alignItems: 'center',
      marginBottom,
    });
    const text = document.createElement('span');
    text.textContent = key;
    label.append(text, input);
    controls.append(label);
  };

  const renderLookValues = (): void => {
    for (const [name, button] of lookButtons) {
      button.setAttribute('aria-pressed', String(name === activeLookName));
    }
    for (const [key, input] of lookRangeInputs) {
      input.value = String(activeLook[key]);
    }
    for (const [key, input] of lookColorInputs) {
      input.value = colorHex(activeLook[key]);
    }
  };

  const lookRow = createButtonRow('LOOK');
  for (const name of LOOK_NAMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.dataset.value = name;
    style(button, { cursor: 'pointer', font: 'inherit', padding: '2px 4px' });
    button.addEventListener('click', () => {
      cancelRegeneration();
      activeLookName = name;
      activeLook = { ...options.lookPresets[name] };
      renderLookValues();
      options.onLook(name);
    });
    lookButtons.set(name, button);
    lookRow.append(button);
  }

  const cancelRegeneration = (): void => {
    if (regenerationTimer === null) return;
    window.clearTimeout(regenerationTimer);
    regenerationTimer = null;
  };

  const queueRegeneration = (regenerate: () => void): void => {
    cancelRegeneration();
    regenerationTimer = window.setTimeout(() => {
      regenerationTimer = null;
      regenerate();
    }, REGENERATE_DELAY_MS);
  };

  for (const key of LOOK_COLOR_CONTROLS) {
    const input = document.createElement('input');
    input.type = 'color';
    input.setAttribute('aria-label', key);
    input.addEventListener('input', () => {
      activeLook = {
        ...activeLook,
        [key]: Number.parseInt(input.value.slice(1), 16),
      };
      if (key === 'cardColor') {
        queueRegeneration(() => options.onLookParams({ ...activeLook }));
      } else {
        options.onLookParams({ ...activeLook });
      }
    });
    lookColorInputs.set(key, input);
    appendLabeledInput(key, input, '6px');
  }

  for (const { key, min, max, step } of LOOK_RANGE_CONTROLS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', key);
    input.addEventListener('input', () => {
      activeLook = { ...activeLook, [key]: Number(input.value) };
      options.onLookParams({ ...activeLook });
    });
    lookRangeInputs.set(key, input);
    appendLabeledInput(key, input, '3px');
  }

  const renderPaperValues = (): void => {
    for (const [key, input] of inputs) input.value = String(activePaper[key]);
  };

  const paperRow = createButtonRow('PAPER');
  for (const name of PAPER_NAMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.dataset.value = name;
    style(button, { cursor: 'pointer', font: 'inherit', padding: '2px 4px' });
    button.addEventListener('click', () => {
      cancelRegeneration();
      activePaper = { ...options.paperPresets[name] };
      renderPaperValues();
      options.onPaper({ ...activePaper });
    });
    paperRow.append(button);
  }

  for (const { key, min, max, step } of RANGE_CONTROLS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', key);
    input.addEventListener('input', () => {
      activePaper = { ...activePaper, [key]: Number(input.value) };
      queueRegeneration(() => options.onPaper({ ...activePaper }));
    });
    inputs.set(key, input);
    appendLabeledInput(key, input, '3px');
  }

  const seedInput = document.createElement('input');
  seedInput.type = 'number';
  seedInput.step = '1';
  seedInput.setAttribute('aria-label', 'seed');
  seedInput.addEventListener('input', () => {
    const seed = Number(seedInput.value);
    if (!Number.isFinite(seed)) return;
    activePaper = { ...activePaper, seed };
    queueRegeneration(() => options.onPaper({ ...activePaper }));
  });
  inputs.set('seed', seedInput);
  appendLabeledInput('seed', seedInput, '6px');

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'COPY PARAMS';
  copyButton.dataset.action = 'copy';
  style(copyButton, { cursor: 'pointer', font: 'inherit', width: '100%' });
  copyButton.addEventListener('click', () => {
    const json = JSON.stringify({
      look: {
        cardColor: colorHex(activeLook.cardColor),
        keyIntensity: activeLook.keyIntensity,
        keyColor: colorHex(activeLook.keyColor),
        fillIntensity: activeLook.fillIntensity,
        fillColor: colorHex(activeLook.fillColor),
        ambientIntensity: activeLook.ambientIntensity,
        printOverlay: activeLook.printOverlay,
      },
      paper: activePaper,
    }, null, 2);
    console.log(json);
    void navigator.clipboard?.writeText(json).catch((error: unknown) => {
      console.error(error);
    });
  });
  controls.append(copyButton);

  toggle.addEventListener('click', () => {
    controls.hidden = !controls.hidden;
    toggle.setAttribute('aria-expanded', String(!controls.hidden));
  });

  options.host.append(element);
  renderLookValues();
  renderPaperValues();

  return {
    element,
    setLook(look, params) {
      cancelRegeneration();
      activeLookName = look;
      activeLook = { ...params };
      renderLookValues();
    },
    setPaper(params) {
      cancelRegeneration();
      activePaper = { ...params };
      renderPaperValues();
    },
    dispose() {
      cancelRegeneration();
      element.remove();
    },
  };
}
