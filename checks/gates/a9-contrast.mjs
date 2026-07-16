// A9：WCAG contrast gate。色值只從 src/styles/tokens.css 讀取，避免 token 變更後
// gate 仍測到舊的硬編值。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CHECKS = [
  { foreground: '--ink-soft', background: '--paper', threshold: 4.5, thresholdLabel: '4.5' },
  { foreground: '--brass-deep', background: '--paper', threshold: 4.5, thresholdLabel: '4.5' },
  { foreground: '--cut', background: '--paper', threshold: 3, thresholdLabel: '3.0' },
];

function parseHexTokens(source) {
  return new Map(
    [...source.matchAll(/^\s*(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gim)]
      .map((match) => [match[1], match[2]]),
  );
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((pair) => Number.parseInt(pair, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export async function run({ root }) {
  const tokenPath = path.join(root, 'src/styles/tokens.css');
  const tokens = parseHexTokens(readFileSync(tokenPath, 'utf8'));
  const errors = [];

  for (const { foreground, background, threshold, thresholdLabel } of CHECKS) {
    const label = `${foreground.slice(2)}/${background.slice(2)}`;
    const foregroundValue = tokens.get(foreground);
    const backgroundValue = tokens.get(background);
    const missing = [
      !foregroundValue ? foreground : null,
      !backgroundValue ? background : null,
    ].filter(Boolean);
    if (missing.length) {
      const message = `${label}: missing six-digit hex token ${missing.join(', ')}`;
      console.log(`[a9] ${message} FAIL`);
      errors.push(message);
      continue;
    }

    const ratio = contrastRatio(foregroundValue, backgroundValue);
    const measured = ratio.toFixed(2);
    if (ratio >= threshold) {
      console.log(`[a9] ${label} ${measured} ≥ ${thresholdLabel} OK`);
    } else {
      const message = `${label} ${measured} < ${thresholdLabel}`;
      console.log(`[a9] ${message} FAIL`);
      errors.push(message);
    }
  }

  return errors;
}
