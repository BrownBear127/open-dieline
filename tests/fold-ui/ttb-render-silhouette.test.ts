// normalized 慣例層：容差與拓撲依測試契約固定。
// 觀測慣例層：凸包與外距取自實際 mesh buffer 座標。
//
// 閘門動機：G5（tests/fold/ttb-sweep-gates.test.ts）量的是 worldGeometry() 數值層，
// 但畫面幾何另走 scene 的 renderedPanelVertices 路徑——兩條路一度分歧（vertexClamp
// 只進了數值層，mesh 仍用原始刀模輪廓，端封件在畫面上凸出 2.3mm 而 G5 全綠）。
// 本閘門直接讀 t=1 的 mesh.geometry.position，驗證「送進 GPU buffer 的」剖面輪廓
// 收在盒體凸包內，封住數值層與渲染層的儀器斷層。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mesh } from 'three';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { buildTtbFoldModel, TTB_BODY_HULL_CLAMP_SPEC } from '@/fold/models/triangular-tube';

const capturedMeshes = vi.hoisted(() => [] as Mesh[]);

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();

  class Renderer {
    toneMapping = 0;
    toneMappingExposure = 1;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
  }

  class CapturedMesh extends actual.Mesh {
    constructor(...args: ConstructorParameters<typeof actual.Mesh>) {
      super(...args);
      capturedMeshes.push(this);
    }
  }

  return {
    ...actual,
    Mesh: CapturedMesh,
    WebGLRenderer: Renderer,
  };
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await vi.importActual<typeof import('three')>('three');

  class OrbitControls {
    target = new Vector3();
    enableDamping = false;
    autoRotate = false;
    minDistance = 0;
    maxDistance = 0;
    update = vi.fn(() => false);
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispose = vi.fn();
  }

  return { OrbitControls };
});

import { createFoldScene } from '@/ui/fold-scene';

// TTB 生產厚度鎖 0；剖面容差 = clamp 接觸容差(0.01) + 顯示層距(0.05) 的裕度。
const THICKNESS_MM = 0;
const CROSS_SECTION_CAP_MM = 0.06;
const AXIAL_CAP_MM = 0.2;
/** 放棄收束的 edge-on 殘留哨兵（與 ttb-sweep-gates G5/G6 同源）：WingBottom
 * 面內收束不成比例（外距 2.385mm 需 60mm 剪移·形狀優先），殘留凍結於此。 */
const PARKED_CROSS_SECTION_CAP_MM: Record<string, number> = {
  endStartWingBottom: 2.5,
  endEndWingBottom: 2.5,
};

type P2 = [number, number];

function convexHull(points: P2[]): P2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (input: P2[]) => {
    const out: P2[] = [];
    for (const p of input) {
      while (out.length >= 2) {
        const [o, q] = [out[out.length - 2]!, out[out.length - 1]!];
        if ((q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0]) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    return out;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function outsideDistance(p: P2, hull: P2[]): number {
  let maxOut = -Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const crossV = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    maxOut = Math.max(maxOut, -crossV / len);
  }
  return maxOut;
}

function mockCanvasContext(): void {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(
    this: HTMLCanvasElement,
  ) {
    return {
      canvas: this,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });
}

function meshPositions(panelId: string): { x: number; y: number; z: number }[] {
  const mesh = capturedMeshes.find(({ name }) => name === `fold-panel:${panelId}`);
  expect(mesh, `找不到 fold-panel:${panelId} mesh`).toBeDefined();
  const attribute = mesh!.geometry.getAttribute('position');
  const points: { x: number; y: number; z: number }[] = [];
  for (let index = 0; index < attribute.count; index += 1) {
    points.push({
      x: attribute.getX(index),
      y: attribute.getY(index),
      z: attribute.getZ(index),
    });
  }
  return points;
}

afterEach(() => {
  capturedMeshes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TTB 渲染層剪影閘門（mesh buffer 為準）', () => {
  it('t=1 時端封件六片的 mesh 頂點全數收在盒體剖面凸包與軸向範圍內', () => {
    mockCanvasContext();
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const scene = createFoldScene(document.createElement('canvas'));
    scene.replaceModel(model, { thickness: THICKNESS_MM });
    scene.updatePose(1);

    const bodyPts: P2[] = TTB_BODY_HULL_CLAMP_SPEC.bodyPanelIds.flatMap((id) =>
      meshPositions(id).map((v): P2 => [v.y, v.z]),
    );
    const hull = convexHull(bodyPts);
    const bodyXs = TTB_BODY_HULL_CLAMP_SPEC.bodyPanelIds.flatMap((id) =>
      meshPositions(id).map((v) => v.x),
    );
    const [x0, x1] = [Math.min(...bodyXs), Math.max(...bodyXs)];

    const violations: string[] = [];
    for (const id of TTB_BODY_HULL_CLAMP_SPEC.targetPanelIds) {
      let maxOut = -Infinity;
      let axial = 0;
      for (const v of meshPositions(id)) {
        maxOut = Math.max(maxOut, outsideDistance([v.y, v.z], hull));
        axial = Math.max(axial, x0 - v.x, v.x - x1);
      }
      const crossCap = PARKED_CROSS_SECTION_CAP_MM[id] ?? CROSS_SECTION_CAP_MM;
      if (maxOut > crossCap || axial > AXIAL_CAP_MM) {
        violations.push(
          `${id}: outside=${maxOut.toFixed(3)}mm axial=${axial.toFixed(3)}mm`,
        );
      }
    }

    expect(violations, violations.join('; ')).toEqual([]);
    scene.dispose();
  });
});
