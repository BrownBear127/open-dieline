// checks/gates/g1-parity.mjs — G1 tokens byte-parity（Spec §8.1）
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function run({ root }) {
  const errs = [];
  const canonical = readFileSync(path.join(root, 'checks/canonical/tokens.css'));
  const app = readFileSync(path.join(root, 'src/styles/tokens.css'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'checks/canonical/manifest.json'), 'utf8'));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (sha(canonical) !== manifest.sha256) errs.push(`vendored canonical 與 manifest sha256 不符（manifest=${manifest.sha256}）`);
  if (!canonical.equals(app)) errs.push('src/styles/tokens.css 與 vendored canonical 非 byte-identical');
  return errs;
}
