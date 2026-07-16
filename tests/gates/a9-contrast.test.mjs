import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../checks/gates/a9-contrast.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKENS_SOURCE = path.join(PROJECT_ROOT, 'src/styles/tokens.css');
const temporaryRoots = [];

function temporaryRootWithTokens(transform = (source) => source) {
  const root = mkdtempSync(path.join(tmpdir(), 'open-dieline-a9-'));
  temporaryRoots.push(root);
  const stylesDir = path.join(root, 'src/styles');
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(path.join(stylesDir, 'tokens.css'), transform(readFileSync(TOKENS_SOURCE, 'utf8')));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('A9 contrast gate discrimination', () => {
  it('passes the checked-in tokens', async () => {
    await expect(run({ root: temporaryRootWithTokens() })).resolves.toEqual([]);
  });

  it('rejects a temporary ink-soft value below 4.5 without editing tokens.css', async () => {
    const root = temporaryRootWithTokens((source) =>
      source.replace(/(--ink-soft:\s*)#[0-9a-f]{6}/i, '$1#FAF7F0'),
    );

    const errors = await run({ root });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ink-soft\/paper 1\.00 < 4\.5/);
  });
});
