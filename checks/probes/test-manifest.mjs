export const REQUIRED_ARTWORK_E2E = [
  'upload png artwork renders a custom frame distinct from none and sample',
  'upload jpeg artwork renders a custom frame distinct from none and sample',
  'upload svg artwork renders a custom frame distinct from none and sample',
  'uploaded artwork lands on the correct panel after folding',
  'upload rejects an invalid file and keeps the previous artwork',
  'upload cancel via file chooser keeps state unchanged',
  're-selecting the same file re-triggers upload',
  'retained custom artwork reports none before custom while returning from DESIGN to FOLD',
  'switching artwork mode during decode discards the stale request',
  'fold artwork upload makes no request outside the localhost origin',
  'A2 en svg-default download is byte-identical to the RTE baseline',
  'A2 en svg-manufacturing download is byte-identical to the RTE baseline',
];

export const REQUIRED_ARTWORK_UNIT = [
  'rejects external CSS @import during the mandatory DOM resource scan',
  'rejects foreignObject with a nested image src during the mandatory DOM resource scan',
  'rejects style attribute with an external url during the mandatory DOM resource scan',
  'rejects mixed-case xlink namespace href during the mandatory DOM resource scan',
  'rejects data URI href during the mandatory DOM resource scan',
  'rejects CSS-escaped url in a style attribute during the mandatory DOM resource scan',
  'rejects CSS-escaped @import in a style element during the mandatory DOM resource scan',
  'rejects image-set string reference in a style element during the mandatory DOM resource scan',
  'rejects image-set string reference in a style attribute during the mandatory DOM resource scan',
];

export function assertNamedTests(listing, requiredNames, label) {
  const missing = requiredNames.filter((name) => !listing.includes(name));
  if (missing.length > 0) throw new Error(`${label} manifest 缺案：${missing.join(', ')}`);
}
