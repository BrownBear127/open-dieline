import type { PaperParams } from './fold-scene';

export type FoldLookName = 'plain' | 'kraft' | 'black' | 'engineering';
export type PaperPresetName = 'subtle' | 'standard' | 'coarse';

interface PaperDevPanelOptions {
  host: HTMLElement;
  initialLook: FoldLookName;
  initialPaper: PaperParams;
  paperPresets: Record<PaperPresetName, PaperParams>;
  onLook: (look: FoldLookName) => void;
  onPaper: (params: PaperParams) => void;
}

export interface PaperDevPanelHandle {
  element: HTMLDivElement;
  setLook(look: FoldLookName): void;
  setPaper(params: PaperParams): void;
  dispose(): void;
}

type RangeKey = Exclude<keyof PaperParams, 'seed'>;

const RANGE_CONTROLS: ReadonlyArray<{
  key: RangeKey;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'fiberStrength', min: 0, max: 1, step: 0.01 },
  { key: 'fiberScale', min: 4, max: 160, step: 1 },
  { key: 'grainStrength', min: 0, max: 1, step: 0.01 },
  { key: 'crumpleStrength', min: 0, max: 1, step: 0.01 },
  { key: 'crumpleScale', min: 0.5, max: 24, step: 0.5 },
  { key: 'bumpScale', min: 0, max: 0.2, step: 0.001 },
  { key: 'roughnessBase', min: 0.2, max: 1, step: 0.01 },
  { key: 'roughnessVariation', min: 0, max: 0.5, step: 0.01 },
];

const LOOK_NAMES: FoldLookName[] = ['plain', 'kraft', 'black', 'engineering'];
const PAPER_NAMES: PaperPresetName[] = ['subtle', 'standard', 'coarse'];
const REGENERATE_DELAY_MS = 150;

function style(element: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, values);
}

export function createPaperDevPanel(
  options: PaperDevPanelOptions,
): PaperDevPanelHandle {
  let activeLook = options.initialLook;
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

  const refreshButtonStates = (): void => {
    for (const [name, button] of lookButtons) {
      button.setAttribute('aria-pressed', String(name === activeLook));
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
      activeLook = name;
      refreshButtonStates();
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

  const queueRegeneration = (): void => {
    cancelRegeneration();
    regenerationTimer = window.setTimeout(() => {
      regenerationTimer = null;
      options.onPaper({ ...activePaper });
    }, REGENERATE_DELAY_MS);
  };

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
    const label = document.createElement('label');
    style(label, {
      display: 'grid',
      gridTemplateColumns: '132px 1fr',
      gap: '6px',
      alignItems: 'center',
      marginBottom: '3px',
    });
    const text = document.createElement('span');
    text.textContent = key;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', key);
    input.addEventListener('input', () => {
      activePaper = { ...activePaper, [key]: Number(input.value) };
      queueRegeneration();
    });
    inputs.set(key, input);
    label.append(text, input);
    controls.append(label);
  }

  const seedLabel = document.createElement('label');
  style(seedLabel, {
    display: 'grid',
    gridTemplateColumns: '132px 1fr',
    gap: '6px',
    alignItems: 'center',
    marginBottom: '6px',
  });
  const seedText = document.createElement('span');
  seedText.textContent = 'seed';
  const seedInput = document.createElement('input');
  seedInput.type = 'number';
  seedInput.step = '1';
  seedInput.setAttribute('aria-label', 'seed');
  seedInput.addEventListener('input', () => {
    const seed = Number(seedInput.value);
    if (!Number.isFinite(seed)) return;
    activePaper = { ...activePaper, seed };
    queueRegeneration();
  });
  inputs.set('seed', seedInput);
  seedLabel.append(seedText, seedInput);
  controls.append(seedLabel);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'COPY PARAMS';
  copyButton.dataset.action = 'copy';
  style(copyButton, { cursor: 'pointer', font: 'inherit', width: '100%' });
  copyButton.addEventListener('click', () => {
    const json = JSON.stringify({ look: activeLook, paper: activePaper }, null, 2);
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
  refreshButtonStates();
  renderPaperValues();

  return {
    element,
    setLook(look) {
      activeLook = look;
      refreshButtonStates();
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
