import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { parseOverlaySvg } from '@/overlay/parse';

const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;

function onlyKind(segs: Segment[], kind: Segment['kind']): boolean {
  return segs.length > 0 && segs.every((s) => s.kind === kind);
}

describe('parseOverlaySvg — 基本形狀元素（各 ×1）', () => {
  it('line → 1 line segment', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="10" y2="10"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]);
    expect(r.warnings).toEqual([]);
  });

  it('polyline → line 序列（不補閉合）', () => {
    const r = parseOverlaySvg(svg('<polyline points="0,0 10,0 10,5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
    ]);
  });

  it('polygon → line 序列＋補閉合線', () => {
    const r = parseOverlaySvg(svg('<polygon points="0,0 10,0 10,5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
      { kind: 'line', x1: 10, y1: 5, x2: 0, y2: 0 },
    ]);
  });

  it('rect（無圓角）→ 4 line，手算四角座標', () => {
    const r = parseOverlaySvg(svg('<rect x="0" y="0" width="10" height="5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
      { kind: 'line', x1: 10, y1: 5, x2: 0, y2: 5 },
      { kind: 'line', x1: 0, y1: 5, x2: 0, y2: 0 },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('rect 有 rx/ry → 警告「rect 圓角」但仍畫 4 line（rounding 被忽略、不擋）', () => {
    const r = parseOverlaySvg(svg('<rect x="0" y="0" width="10" height="5" rx="2"/>'));
    expect(r.segments).toHaveLength(4);
    expect(r.warnings).toEqual(['rect 圓角（rx/ry） ×1 未匯入']);
  });

  it('circle → 兩個半圓 arc（0→π、π→2π，ccw=false；FX1 修正：單一 full-circle arc 起訖點座標相同，Canvas 的 SVG A 指令渲染起訖點重合＝零渲染，見 parse.ts circleToSegments 文件的探針推導）', () => {
    const r = parseOverlaySvg(svg('<circle cx="5" cy="5" r="3"/>'));
    expect(r.segments).toEqual([
      { kind: 'arc', cx: 5, cy: 5, r: 3, startAngle: 0, endAngle: Math.PI, ccw: false },
      { kind: 'arc', cx: 5, cy: 5, r: 3, startAngle: Math.PI, endAngle: 2 * Math.PI, ccw: false },
    ]);
  });

  it('ellipse → 4 段 a2c bezier（獨立推導：rx=4,ry=2,第一段 0°→90° 手算控制點）', () => {
    const r = parseOverlaySvg(svg('<ellipse cx="0" cy="0" rx="4" ry="2"/>'));
    expect(r.segments).toHaveLength(4);
    expect(onlyKind(r.segments, 'bezier')).toBe(true);
    const first = r.segments[0]!;
    if (first.kind !== 'bezier') throw new Error('expected bezier');
    // 獨立推導（node -e 手算，非跑實作結果）：kappa=4/3*tan(22.5°)=0.5522847498307933
    expect(first.x1).toBeCloseTo(4, 6);
    expect(first.y1).toBeCloseTo(0, 6);
    expect(first.c1x).toBeCloseTo(4, 6);
    expect(first.c1y).toBeCloseTo(1.1045694996615867, 6);
    expect(first.c2x).toBeCloseTo(2.209138999323174, 6);
    expect(first.c2y).toBeCloseTo(2, 6);
    expect(first.x2).toBeCloseTo(0, 6);
    expect(first.y2).toBeCloseTo(2, 6);
    // 首尾相接回到起點（完整橢圓一圈）
    const last = r.segments[3]!;
    if (last.kind !== 'bezier') throw new Error('expected bezier');
    expect(last.x2).toBeCloseTo(4, 6);
    expect(last.y2).toBeCloseTo(0, 6);
  });
});

describe('parseOverlaySvg — path：M/L/H/V（絕對＋相對）', () => {
  it('M/L 絕對＋Z 補閉合線（未閉合時）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L10,0 L10,5 Z"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
      { kind: 'line', x1: 10, y1: 5, x2: 0, y2: 0 },
    ]);
  });

  it('Z 在已閉合（游標已在子路徑起點）時不補零長度線', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L10,0 L10,5 L0,0 Z"/>'));
    expect(r.segments).toHaveLength(3); // 3 條 L，Z 不再補第 4 條
  });

  it('M 隱式重複座標對＝L（單一 M 後接多組座標）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 10,0 10,5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
    ]);
  });

  it('相對 m/l（小寫）：手算——首個 m 因游標始於(0,0)等同絕對，後續 l 疊加相對位移', () => {
    const r = parseOverlaySvg(svg('<path d="m1,1 l9,0 l0,5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 1, y1: 1, x2: 10, y2: 1 },
      { kind: 'line', x1: 10, y1: 1, x2: 10, y2: 6 },
    ]);
  });

  it('H/V 絕對＋相對混合組成矩形（手算：H10→V5→h-10→v-5 回到原點）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 H10 V5 h-10 v-5"/>'));
    expect(r.segments).toEqual([
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 5 },
      { kind: 'line', x1: 10, y1: 5, x2: 0, y2: 5 },
      { kind: 'line', x1: 0, y1: 5, x2: 0, y2: 0 },
    ]);
  });

  it('數字間省略分隔符（負號緊貼前一數字）：常見生產檔案寫法，L10-5 應拆成 (10,-5)', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L10-5"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: -5 }]);
  });

  it('科學記號座標（1e-5 級）：NUMBER_STICKY_RE 的 [eE][-+]?\\d+ 分支需正確吃下指數部分', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L1e-5,2e-5"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 0.00001, y2: 0.00002 }]);
  });
});

describe('parseOverlaySvg — path：C/S（三次貝茲＋反射）', () => {
  it('相對 c（小寫，非零起點排除巧合）：手算 M2,3 c1,2 3,4 5,6', () => {
    const r = parseOverlaySvg(svg('<path d="M2,3 c1,2 3,4 5,6"/>'));
    expect(r.segments).toEqual([{ kind: 'bezier', x1: 2, y1: 3, c1x: 3, c1y: 5, c2x: 5, c2y: 7, x2: 7, y2: 9 }]);
  });

  it('S 反射前一個 C 的 c2（手算：reflect=2·p0−prevC2）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 C1,2 3,4 5,6 S9,10 11,12"/>'));
    expect(r.segments).toHaveLength(2);
    const s = r.segments[1]!;
    if (s.kind !== 'bezier') throw new Error('expected bezier');
    // reflect(p0=(5,6), ctrl=(3,4)) = (2*5-3, 2*6-4) = (7,8)
    expect(s).toEqual({ kind: 'bezier', x1: 5, y1: 6, c1x: 7, c1y: 8, c2x: 9, c2y: 10, x2: 11, y2: 12 });
  });

  it('S 前一指令非 C/S 時反射點＝當前點（手算：reflectPoint(p0,p0)=p0）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L5,5 S9,10 11,12"/>'));
    const s = r.segments[1]!;
    if (s.kind !== 'bezier') throw new Error('expected bezier');
    expect(s).toEqual({ kind: 'bezier', x1: 5, y1: 5, c1x: 5, c1y: 5, c2x: 9, c2y: 10, x2: 11, y2: 12 });
  });
});

describe('parseOverlaySvg — path：Q/T（二次→三次升階＋反射）', () => {
  it('Q 升階公式：c1=p0+2/3(q−p0)、c2=p3+2/3(q−p3)（獨立推導 node -e 手算核對）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 Q4,6 8,0"/>'));
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    if (s.kind !== 'bezier') throw new Error('expected bezier');
    expect(s.x1).toBeCloseTo(0, 6);
    expect(s.y1).toBeCloseTo(0, 6);
    expect(s.c1x).toBeCloseTo(8 / 3, 6);
    expect(s.c1y).toBeCloseTo(4, 6);
    expect(s.c2x).toBeCloseTo(16 / 3, 6);
    expect(s.c2y).toBeCloseTo(4, 6);
    expect(s.x2).toBeCloseTo(8, 6);
    expect(s.y2).toBeCloseTo(0, 6);
  });

  it('T 反射前一個 Q 的控制點後同樣升階（獨立推導：反射點=(12,-6)，見 report）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 Q4,6 8,0 T16,0"/>'));
    expect(r.segments).toHaveLength(2);
    const s = r.segments[1]!;
    if (s.kind !== 'bezier') throw new Error('expected bezier');
    expect(s.x1).toBeCloseTo(8, 6);
    expect(s.y1).toBeCloseTo(0, 6);
    expect(s.c1x).toBeCloseTo(32 / 3, 6); // 10.666...
    expect(s.c1y).toBeCloseTo(-4, 6);
    expect(s.c2x).toBeCloseTo(40 / 3, 6); // 13.333...
    expect(s.c2y).toBeCloseTo(-4, 6);
    expect(s.x2).toBeCloseTo(16, 6);
    expect(s.y2).toBeCloseTo(0, 6);
  });
});

describe('parseOverlaySvg — path：A（橢圓弧）', () => {
  it('sweep=1 圓弧：cx/cy/ccw/角度與 core/path.ts 既有測試數值交叉核對（同一 W3C 映射的特例）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,-5 A5,5 0 0,1 5,0"/>'));
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(0, 6);
    expect(s.cy).toBeCloseTo(0, 6);
    expect(s.r).toBeCloseTo(5, 6);
    expect(s.ccw).toBe(false); // sweep=1 → ccw=false
    expect(s.startAngle).toBeCloseTo(-Math.PI / 2, 6);
    expect(s.endAngle).toBeCloseTo(0, 6);
  });

  it('sweep=0 圓弧：鏡像圓心 (5,-5)、ccw=true（同上交叉核對）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,-5 A5,5 0 0,0 5,0"/>'));
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(5, 6);
    expect(s.cy).toBeCloseTo(-5, 6);
    expect(s.ccw).toBe(true);
  });

  it('largeArc=1 且 sweep=0：改選另一圓心 (0,0)（獨立推導 F.6.5 sign=(fA≠fS)?+1:-1，非 path.ts 既有涵蓋範圍）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,-5 A5,5 0 1,0 5,0"/>'));
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(0, 6);
    expect(s.cy).toBeCloseTo(0, 6);
    expect(s.ccw).toBe(true); // ccw 只由 sweep 決定，largeArc 不影響
  });

  it('相對 a 指令：偏移量與絕對版本等價端點，應得相同圓心/角度（cross-check 復用上面已驗證數值）', () => {
    const r = parseOverlaySvg(svg('<path d="M0,-5 a5,5 0 0,1 5,5"/>'));
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(0, 6);
    expect(s.cy).toBeCloseTo(0, 6);
    expect(s.ccw).toBe(false);
    expect(s.startAngle).toBeCloseTo(-Math.PI / 2, 6);
    expect(s.endAngle).toBeCloseTo(0, 6);
  });

  it('真橢圓（rx=2ry）→ 全部轉 bezier、無 arc；端點連續（起訖點吻合輸入）', () => {
    const r = parseOverlaySvg(svg('<path d="M4,0 A4,2 0 0,1 0,2"/>'));
    expect(r.segments.length).toBeGreaterThan(0);
    expect(onlyKind(r.segments, 'bezier')).toBe(true);
    const first = r.segments[0]!;
    const last = r.segments[r.segments.length - 1]!;
    if (first.kind !== 'bezier' || last.kind !== 'bezier') throw new Error('expected bezier');
    expect(first.x1).toBeCloseTo(4, 6);
    expect(first.y1).toBeCloseTo(0, 6);
    expect(last.x2).toBeCloseTo(0, 6);
    expect(last.y2).toBeCloseTo(2, 6);
  });

  it('phi≠0 的真橢圓弧（釘住 x-axis-rotation branch，先前所有 A 測試 phi 皆為 0）：獨立重寫 F.6.5 + a2c 腳本核對，非呼叫 parse.ts', () => {
    // 橢圓 cx=2,cy=-1,rx=6,ry=3,phi=30°，θ1=20°→θ2=100°（80° 掃角，sweep=1／largeArc=0）。
    // 半徑/角度取自法蘭給定的獨立 round-trip 驗證案例（cx=2,cy=-1,rx=6,ry=3,phi=30°），僅將
    // θ2 由 110°改為 100°：110°會讓掃角恰為 90°，endpoint→center 反算回來的 deltaTheta 因浮
    // 點誤差落在 90.00000000000001°，使 segCount=ceil(deltaTheta/90°) 從 1 變 2、多出一段
    // bezier；80° 掃角離邊界夠遠，segCount 穩定為 1，測試不會因無關的浮點捨入而變脆弱。
    // M/A 端點座標、bezier 控制點皆用同一 a2c 公式（toEllipse + kappa=4/3·tan(段角/4)，與
    // ellipseThetaRangeToBeziers 文件註解同一公式）獨立手推＋node 計算機核對，見 task-3-report.md。
    const r = parseOverlaySvg(svg('<path d="M6.3697558731077395,2.7076722605357966 A6,3 30 0,1 -0.3795140286009233,1.037661062856539"/>'));
    expect(r.segments).toHaveLength(1); // 80°＜90°，單段 bezier（segCount=ceil(80/90)=1）
    expect(onlyKind(r.segments, 'bezier')).toBe(true);
    const s = r.segments[0]!;
    if (s.kind !== 'bezier') throw new Error('expected bezier');
    expect(s.x1).toBeCloseTo(6.3697558731077395, 6);
    expect(s.y1).toBeCloseTo(2.7076722605357966, 6);
    expect(s.c1x).toBeCloseTo(4.823257156396382, 6);
    expect(s.c1y).toBeCloseTo(3.394524184679877, 6);
    expect(s.c2x).toBeCloseTo(1.977430510572436, 6);
    expect(s.c2y).toBeCloseTo(2.6903647075226775, 6);
    expect(s.x2).toBeCloseTo(-0.3795140286009233, 6);
    expect(s.y2).toBeCloseTo(1.037661062856539, 6);
  });

  it('起訖點重合（spec：無操作，不產生 segment）', () => {
    const r = parseOverlaySvg(svg('<path d="M5,5 A3,3 0 0,1 5,5 L10,10"/>'));
    // A 指令本身不產生 segment，只有後面的 L 產生 1 條
    expect(r.segments).toEqual([{ kind: 'line', x1: 5, y1: 5, x2: 10, y2: 10 }]);
  });

  it('largeArc/sweep flag 緊貼下一座標（無分隔符的 compact 寫法，如 Illustrator 極簡化輸出）：flag 須當單一字元讀取，不可與後續座標黏成一個數字', () => {
    // "1025,25" = largeArc(1)+sweep(0)+x(25)（緊貼）,y(25)（逗號分隔）。獨立重寫 F.6.5/F.6.6 腳本核對
    // （非呼叫 parse.ts，見 task-3-report.md）：M0,0→(25,25)、rx0=ry0=5 但 chord 遠超直徑，F.6.6 等比放大
    // 後仍 rx=ry（保持圓）；largeArc=1,sweep=0 → sign=+1 → cx≈cy≈12.5、r=25/√2≈17.677669529663688、
    // ccw=!sweep=true、startAngle=atan2(-12.5,-12.5)≈-3π/4、endAngle=atan2(12.5,12.5)≈π/4。
    const r = parseOverlaySvg(svg('<path d="M0,0 A5,5 0 1025,25"/>'));
    expect(r.segments).toHaveLength(1); // 修復前：整段 A 因參數只讀到 5 個（不足 7）被丟棄，segments=[]
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc（rx0=ry0 相等，F.6.6 等比縮放後仍圓）');
    expect(s.cx).toBeCloseTo(12.5, 6);
    expect(s.cy).toBeCloseTo(12.5, 6);
    expect(s.r).toBeCloseTo(25 / Math.sqrt(2), 6);
    expect(s.ccw).toBe(true);
    expect(s.startAngle).toBeCloseTo((-3 * Math.PI) / 4, 6);
    expect(s.endAngle).toBeCloseTo(Math.PI / 4, 6);
  });

  it('相對 a 指令的 flag 緊貼版（"0125,25" = largeArc(0)+sweep(1)+dx(25)緊貼,dy(25)）：中心/半徑同上（largeArc/sweep 不影響選中的圓，只影響 ccw）、ccw 因 sweep=1 翻轉為 false', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 a5,5 0 0125,25"/>'));
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(12.5, 6);
    expect(s.cy).toBeCloseTo(12.5, 6);
    expect(s.r).toBeCloseTo(25 / Math.sqrt(2), 6);
    expect(s.ccw).toBe(false);
  });
});

describe('parseOverlaySvg — transform 展平', () => {
  it('嵌套 g（translate+scale 累乘）：手算端點 = translate(scale(point))', () => {
    const r = parseOverlaySvg(
      svg('<g transform="translate(10,20)"><g transform="scale(2,3)"><line x1="1" y1="1" x2="4" y2="5"/></g></g>'),
    );
    // scale(2,3)*(1,1)=(2,3) → +translate(10,20) = (12,23)；(4,5)*(2,3)=(8,15) → (18,35)
    expect(r.segments).toEqual([{ kind: 'line', x1: 12, y1: 23, x2: 18, y2: 35 }]);
  });

  it('單一 transform 屬性內多函式左到右合成（rightmost 先套用）：translate(10,0) rotate(90) 於 (1,0)', () => {
    const r = parseOverlaySvg(svg('<g transform="translate(10,0) rotate(90)"><line x1="1" y1="0" x2="1" y2="0"/></g>'));
    const s = r.segments[0]!;
    if (s.kind !== 'line') throw new Error('expected line');
    // rotate(90) 先套用：(1,0)→(0,1)；再 translate(10,0)：→(10,1)（手算：cos90=0,sin90=1）
    expect(s.x1).toBeCloseTo(10, 6);
    expect(s.y1).toBeCloseTo(1, 6);
  });

  it('matrix() 函式：matrix(1,0,0,1,5,5) 等同 translate(5,5)', () => {
    const r = parseOverlaySvg(svg('<g transform="matrix(1,0,0,1,5,5)"><line x1="0" y1="0" x2="1" y2="1"/></g>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 5, y1: 5, x2: 6, y2: 6 }]);
  });

  it('rotate(deg,cx,cy) 三參數繞點旋轉：rotate(90,1,1) 於 (2,1)-(1,2)（手算：平移到原點旋轉再移回，獨立 node 腳本核對）', () => {
    const r = parseOverlaySvg(svg('<g transform="rotate(90,1,1)"><line x1="2" y1="1" x2="1" y2="2"/></g>'));
    const s = r.segments[0]!;
    if (s.kind !== 'line') throw new Error('expected line');
    // (2,1)：shift(1,0)→rotate90(0,1)→shift back(1,2)。(1,2)：shift(0,1)→rotate90(-1,0)→shift back(0,1)
    // toBeCloseTo（非 toEqual）：矩陣三連乘（back*rot*toOrigin）比逐步套用點變換多一層浮點捨入，
    // cos(90°)非精確 0 殘留的 ~1e-16 級誤差會透過矩陣合成傳播到略多於 1 ULP（同既有 rotate 測試慣例）。
    expect(s.x1).toBeCloseTo(1, 6);
    expect(s.y1).toBeCloseTo(2, 6);
    expect(s.x2).toBeCloseTo(0, 6);
    expect(s.y2).toBeCloseTo(1, 6);
  });

  it('rotate(45) 下的 arc：角度偏移 +45°、圓心/半徑不變（獨立推導：det>0 純旋轉分支）', () => {
    const r = parseOverlaySvg(svg('<g transform="rotate(45)"><path d="M0,-5 A5,5 0 0,1 5,0"/></g>'));
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(0, 6);
    expect(s.cy).toBeCloseTo(0, 6);
    expect(s.r).toBeCloseTo(5, 6);
    expect(s.ccw).toBe(false);
    expect(s.startAngle).toBeCloseTo(-Math.PI / 4, 6); // -90°+45°
    expect(s.endAngle).toBeCloseTo(Math.PI / 4, 6); // 0°+45°
  });

  it('scale(1,2)（非等比）下的 arc → 全部展開成 bezier（判準：a²+b²≠c²+d²）', () => {
    const r = parseOverlaySvg(svg('<g transform="scale(1,2)"><path d="M0,-5 A5,5 0 0,1 5,0"/></g>'));
    expect(r.segments.length).toBeGreaterThan(0);
    expect(onlyKind(r.segments, 'bezier')).toBe(true);
    const first = r.segments[0]!;
    const last = r.segments[r.segments.length - 1]!;
    if (first.kind !== 'bezier' || last.kind !== 'bezier') throw new Error('expected bezier');
    // 端點連續性：局部起訖點 (0,-5)/(5,0) 經 scale(1,2) → (0,-10)/(5,0)
    expect(first.x1).toBeCloseTo(0, 6);
    expect(first.y1).toBeCloseTo(-10, 6);
    expect(last.x2).toBeCloseTo(5, 6);
    expect(last.y2).toBeCloseTo(0, 6);
  });

  it('scale(-1,1)（鏡射）下的 arc → ccw 翻轉、角度映射 φ−θ（獨立推導：φ=atan2(0,-1)=180°）', () => {
    const r = parseOverlaySvg(svg('<g transform="scale(-1,1)"><path d="M0,-5 A5,5 0 0,1 5,0"/></g>'));
    const s = r.segments[0]!;
    if (s.kind !== 'arc') throw new Error('expected arc');
    expect(s.cx).toBeCloseTo(0, 6);
    expect(s.cy).toBeCloseTo(0, 6);
    expect(s.r).toBeCloseTo(5, 6);
    expect(s.ccw).toBe(true); // 原本 false，鏡射後翻轉
    expect(s.startAngle).toBeCloseTo((3 * Math.PI) / 2, 6); // π−(−π/2)
    expect(s.endAngle).toBeCloseTo(Math.PI, 6); // π−0
  });
});

describe('parseOverlaySvg — 未支援元素：警告去重計數、segments 不受影響', () => {
  it('text ×3／use ×1／image ×1／嵌套 svg ×1：警告含計數，內容不進 segments', () => {
    const r = parseOverlaySvg(
      svg(
        '<text>a</text><text>b</text><text>c</text>' +
          '<use href="#foo"/>' +
          '<image href="x.png"/>' +
          '<svg><rect x="0" y="0" width="1" height="1"/></svg>' +
          '<line x1="0" y1="0" x2="1" y2="1"/>',
      ),
    );
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }]);
    expect(r.warnings).toContain('<text> ×3 未匯入');
    expect(r.warnings).toContain('<use> ×1 未匯入');
    expect(r.warnings).toContain('<image> ×1 未匯入');
    expect(r.warnings).toContain('<svg> ×1 未匯入');
    expect(r.warnings).toHaveLength(4);
  });
});

describe('parseOverlaySvg — transform 子集外函式（skewX/skewY 等）：警告但矩陣仍回 identity、元素照常匯入', () => {
  it('skewX(20)：警告存在＋該 line 仍以 identity 匯入（座標不受影響，非「不擋匯入」不代表「不提示」）', () => {
    const r = parseOverlaySvg(svg('<g transform="skewX(20)"><line x1="0" y1="0" x2="1" y2="1"/></g>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }]);
    expect(r.warnings).toEqual(['transform skewX 不支援，已忽略 ×1']);
  });

  it('同函式名出現於 2 個不同元素的 transform → 去重計數 ×2（非各自獨立警告）', () => {
    const r = parseOverlaySvg(
      svg(
        '<g transform="skewX(10)"><line x1="0" y1="0" x2="1" y2="1"/></g>' +
          '<g transform="skewX(20)"><line x1="0" y1="0" x2="2" y2="2"/></g>',
      ),
    );
    expect(r.warnings).toEqual(['transform skewX 不支援，已忽略 ×2']);
  });
});

describe('parseOverlaySvg — NaN 座標（生產檔案常見帶單位字串如 "10mm"）：含 NaN 的 segment 丟棄＋警告，其餘元素不受影響', () => {
  it('<line x2="10mm"> 讓 Number() 產生 NaN → 該 segment 被過濾，另一條正常 line 不受影響', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="10mm" y2="5"/><line x1="1" y1="1" x2="2" y2="2"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 1, y1: 1, x2: 2, y2: 2 }]);
    expect(r.warnings).toEqual(['1 個線段座標無法解析，已略過']);
  });
});

describe('parseOverlaySvg — path 資料部分消費（tokenizer 中途遇壞檔即停）：前段仍匯入＋警告，不再靜默丟失後段', () => {
  it('"M0,0 L10,10 garbage L20,20"：前兩個指令有效匯入，garbage 起（含後面的 L20,20）視為未消費殘留', () => {
    const r = parseOverlaySvg(svg('<path d="M0,0 L10,10 garbage L20,20"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]);
    expect(r.warnings).toEqual(['path 資料不完整，部分內容 ×1 未匯入']);
  });
});

describe('parseOverlaySvg — class/style 屬性（brief 明列不支援樣式繼承）：警告但元素仍全部視為刀線匯入', () => {
  it('帶 class 的 line → 匯入＋警告（CSS 可能設 hidden，但這裡一律當刀線匯入，不擅自排除）', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="10" y2="10" class="hidden"/>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]);
    expect(r.warnings).toEqual(['1 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）']);
  });

  it('帶 style 屬性同樣觸發警告（class／style 共用同一計數，不分別計）', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="1" y2="1" style="stroke:red"/>'));
    expect(r.warnings).toEqual(['1 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）']);
  });

  it('FX4：<g class="layer"> 包裹的 line → 警告存在（修前 g 分支在檢查前就 return，被忽略；Illustrator 圖層樣式常掛在 g 上）', () => {
    const r = parseOverlaySvg(svg('<g class="layer"><line x1="0" y1="0" x2="10" y2="10"/></g>'));
    expect(r.segments).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]);
    expect(r.warnings).toEqual(['1 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）']);
  });

  it('FX4：<g style="display:none"> 同樣觸發警告（同一 g/shape 判斷邏輯，style 屬性名不分別計）', () => {
    const r = parseOverlaySvg(svg('<g style="display:none"><line x1="0" y1="0" x2="1" y2="1"/></g>'));
    expect(r.warnings).toEqual(['1 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）']);
  });

  it('FX4：g 與其內部 shape 都帶 class → 計數 ×2（各自獨立計，不因巢狀關係合併成 1）', () => {
    const r = parseOverlaySvg(svg('<g class="layer"><line x1="0" y1="0" x2="1" y2="1" class="cut-line"/></g>'));
    expect(r.warnings).toEqual(['2 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入）']);
  });
});

describe('parseOverlaySvg — 壞檔容錯', () => {
  it('非 XML → 空 segments＋警告（不 throw）', () => {
    const r = parseOverlaySvg('this is not xml <<< at all');
    expect(r.segments).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('SVG 解析失敗');
  });

  it('空字串 → 空 segments＋警告', () => {
    const r = parseOverlaySvg('');
    expect(r.segments).toEqual([]);
    expect(r.warnings[0]).toContain('SVG 解析失敗');
  });
});

describe('parseOverlaySvg — 生產刀模樣式：一線一 <g id="LINE##">', () => {
  it('6 條線各自被 <g id="LINE##"> 包裹 → 6 line', () => {
    const groups = Array.from({ length: 6 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return `<g id="LINE${n}"><path d="M${i},0 L${i},10"/></g>`;
    }).join('');
    const r = parseOverlaySvg(svg(groups));
    expect(r.segments).toHaveLength(6);
    expect(onlyKind(r.segments, 'line')).toBe(true);
  });
});

describe('parseOverlaySvg — sourceInfo', () => {
  it('回傳 root svg 的 width/viewBox 原始字串（供 T4 校準使用，這裡不做任何換算）', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="1" y2="1"/>', ' width="210mm" viewBox="0 0 210 297"'));
    expect(r.sourceInfo).toEqual({ widthAttr: '210mm', viewBox: '0 0 210 297' });
  });

  it('無 width/viewBox 屬性時回傳 null', () => {
    const r = parseOverlaySvg(svg('<line x1="0" y1="0" x2="1" y2="1"/>'));
    expect(r.sourceInfo).toEqual({ widthAttr: null, viewBox: null });
  });
});
