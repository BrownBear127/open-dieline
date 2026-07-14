/* ── parametric tray dieline (from slice A) ── */
const svg = document.getElementById('die');
const inputs = { w: document.getElementById('w'), d: document.getElementById('d'), h: document.getElementById('h') };
const outs = { w: document.getElementById('w-out'), d: document.getElementById('d-out'), h: document.getElementById('h-out') };

function draw() {
  const W = +inputs.w.value, D = +inputs.d.value, H = +inputs.h.value;
  const fl = Math.min(H * 0.7, 40);
  const pad = 26;
  const cut = [
    `M 0 ${-H}`, `L ${W} ${-H}`, `L ${W} 0`,
    `L ${W + 6} ${-fl}`, `L ${W + H - 4} ${-fl}`, `L ${W + H} 0`,
    `L ${W + H} ${D}`,
    `L ${W + H - 4} ${D + fl}`, `L ${W + 6} ${D + fl}`, `L ${W} ${D}`,
    `L ${W} ${D + H}`, `L 0 ${D + H}`, `L 0 ${D}`,
    `L ${-6} ${D + fl}`, `L ${-H + 4} ${D + fl}`, `L ${-H} ${D}`,
    `L ${-H} 0`,
    `L ${-H + 4} ${-fl}`, `L ${-6} ${-fl}`, `L 0 0`, `Z`
  ].join(' ');
  const creases = [
    [0, 0, W, 0], [0, D, W, D], [0, 0, 0, D], [W, 0, W, D],
    [-H, 0, 0, 0], [-H, D, 0, D], [W, 0, W + H, 0], [W, D, W + H, D]
  ];
  const x0 = -H - pad, y0 = -H - fl - pad;
  const vw = W + 2 * H + 2 * pad, vh = D + 2 * H + 2 * fl + 2 * pad;
  svg.setAttribute('viewBox', `${x0} ${y0} ${vw} ${vh}`);
  const sw = Math.max(vw, vh) / 480;
  svg.innerHTML =
    `<path d="${cut}" fill="rgba(25,23,18,0.025)" stroke="var(--cut)" stroke-width="${sw * 1.5}" stroke-linejoin="miter"/>` +
    creases.map(c =>
      `<line x1="${c[0]}" y1="${c[1]}" x2="${c[2]}" y2="${c[3]}" stroke="var(--crease)" stroke-width="${sw * 1.4}" stroke-dasharray="${sw * 7} ${sw * 5}"/>`
    ).join('') +
    `<text x="${W / 2}" y="${D / 2}" text-anchor="middle" dominant-baseline="central"
       font-family="IBM Plex Mono, monospace" font-size="${Math.min(W, D) / 9}"
       fill="var(--ink-soft)" letter-spacing="1">${W}×${D}×${H}</text>`;
  outs.w.innerHTML = `${W}<small>mm</small>`;
  outs.d.innerHTML = `${D}<small>mm</small>`;
  outs.h.innerHTML = `${H}<small>mm</small>`;
}
Object.values(inputs).forEach(i => i.addEventListener('input', draw));
draw();

/* ── scroll-triggered reveals ── */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));
