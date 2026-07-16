import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { easings } from '@/fold/easings';
import { foldPose } from '@/fold/schedule';
import type { FoldModel } from '@/fold/types';

const model: FoldModel = {
  panels: [
    { id: 'root', polygon: [], parent: null, foldAngle: Math.PI },
    { id: 'side-a', polygon: [], parent: 'root', foldAngle: Math.PI / 2 },
    { id: 'side-b', polygon: [], parent: 'root', foldAngle: -Math.PI / 4 },
  ],
  steps: [
    { panelIds: ['side-a'], t0: 0.2, t1: 0.6, ease: 'linear' },
    { panelIds: ['side-b'], t0: 0.6, t1: 1, ease: 'powerInOut' },
  ],
};

describe('foldPose', () => {
  it('t=0 時全部面板角度為 0，包含 root', () => {
    expect(foldPose(0, model)).toEqual(
      new Map([
        ['root', 0],
        ['side-a', 0],
        ['side-b', 0],
      ]),
    );
  });

  it('t=1 時全部非 root 面板到達 foldAngle，root 維持 0', () => {
    expect(foldPose(1, model)).toEqual(
      new Map([
        ['root', 0],
        ['side-a', Math.PI / 2],
        ['side-b', -Math.PI / 4],
      ]),
    );
  });

  it('linear step 中點產生一半 foldAngle', () => {
    const pose = foldPose(0.4, model);
    expect(pose.get('side-a')).toBeCloseTo(Math.PI / 4, 12);
  });

  it('將範圍外的 t clamp 到 [0, 1]', () => {
    expect(foldPose(-1, model)).toEqual(foldPose(0, model));
    expect(foldPose(2, model)).toEqual(foldPose(1, model));
  });
});

describe('easings', () => {
  it('backIn 在起始區間回拉，且端點精確落在 0 與 1', () => {
    expect(easings.backIn(0.1)).toBeLessThan(0);
    expect(easings.backIn(0)).toBeCloseTo(0, 9);
    expect(easings.backIn(1)).toBeCloseTo(1, 9);
  });

  it.each(['linear', 'powerInOut', 'backIn'] as const)('%s 的兩個端點為 0 與 1', (easeName) => {
    expect(easings[easeName](0)).toBeCloseTo(0, 9);
    expect(easings[easeName](1)).toBeCloseTo(1, 9);
  });
});

describe('fold import boundary', () => {
  it('src/fold 下所有 TypeScript 檔案不依賴 Three、React 或 UI', () => {
    const foldDir = path.resolve(process.cwd(), 'src/fold');
    const source = fs
      .globSync('**/*.ts', { cwd: foldDir })
      .map((file) => fs.readFileSync(path.join(foldDir, file), 'utf8'))
      .join('\n');
    const specifiers = [...source.matchAll(
      /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    )].map((match) => match[1] ?? match[2]!);
    const forbiddenRoots = ['three', 'react', '@/ui'];
    const forbiddenSpecifiers = specifiers.filter((specifier) => forbiddenRoots.some(
      (root) => specifier === root || specifier.startsWith(`${root}/`),
    ));

    expect(forbiddenSpecifiers).toEqual([]);
  });
});
