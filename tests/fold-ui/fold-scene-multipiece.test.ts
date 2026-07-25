import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BufferAttribute,
  Mesh,
} from 'three';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { applyTransform } from '@/fold/pose3d';
import {
  evaluateResolvedScenePiecePose,
} from '@/fold/scene-pose';
import {
  resolveFoldSceneSpec,
  type ResolvedSceneSpec,
} from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';

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

import {
  computeSceneCameraFrame,
  createFoldScene,
  createPanelRenderPoseContext,
  panelSolidPositions,
} from '@/ui/fold-scene';
import { earClipIndices } from '@/ui/triangulate';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

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

function activePanelMeshes(): Mesh[] {
  return capturedMeshes.filter((mesh) => {
    if (!Array.isArray(mesh.material)) return false;
    let ancestor = mesh.parent;
    while (ancestor !== null) {
      if (ancestor.name === 'fold-panel-root') return true;
      ancestor = ancestor.parent;
    }
    return false;
  });
}

function singleHingedModel(): FoldModel {
  return {
    panels: [
      {
        id: 'root',
        polygon: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
        ],
        parent: null,
        foldAngle: 0,
      },
      {
        id: 'topLid',
        polygon: [
          { x: 2, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 2 },
          { x: 2, y: 2 },
        ],
        parent: 'root',
        hingeLine: {
          a: { x: 2, y: 0 },
          b: { x: 2, y: 2 },
        },
        foldAngle: Math.PI / 2,
      },
    ],
    steps: [{
      t0: 0,
      t1: 1,
      ease: 'linear',
      panelIds: ['topLid'],
    }],
    dieline: [],
  };
}

afterEach(() => {
  capturedMeshes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__p3SetPanelVisible;
});

describe('FoldScene multi-piece runtime', () => {
  it.each([
    ['liner-on', {}],
    ['liner-off', { linerEnabled: false }],
  ])('instantiates the telescope %s scene and evaluates the complete global timeline', (
    _caseId,
    delta,
  ) => {
    mockCanvasContext();
    const params = resolveParams(telescope, delta);
    const resolved = resolveFoldSceneSpec(
      buildTelescopeSceneSpec(params),
      params,
    );
    const scene = createFoldScene(document.createElement('canvas'));

    expect(() => {
      scene.replaceScene(resolved, {
        thickness: params.thickness as number,
      });
      for (let sample = 0; sample <= 100; sample += 1) {
        scene.updatePose(sample / 100);
      }
    }).not.toThrow();

    const pieceIds = new Set(
      activePanelMeshes().map((mesh) => mesh.parent?.name),
    );
    expect(pieceIds).toEqual(new Set(
      params.linerEnabled === false
        ? ['fold-piece:base', 'fold-piece:lid']
        : ['fold-piece:base', 'fold-piece:lid', 'fold-piece:liner'],
    ));
    scene.dispose();
  }, 30_000);

  it('uses prefixed panel ids and removes every liner object when the next scene turns it off', () => {
    mockCanvasContext();
    const onParams = resolveParams(telescope, { linerEnabled: true });
    const offParams = resolveParams(telescope, { linerEnabled: false });
    const onScene = resolveFoldSceneSpec(buildTelescopeSceneSpec(onParams), onParams);
    const offScene = resolveFoldSceneSpec(buildTelescopeSceneSpec(offParams), offParams);
    const scene = createFoldScene(document.createElement('canvas'));

    scene.replaceScene(onScene);
    const linerMesh = activePanelMeshes().find(
      (mesh) => mesh.name.startsWith('fold-panel:liner:'),
    );
    expect(linerMesh).toBeDefined();
    const setVisible = (window as unknown as {
      __p3SetPanelVisible: (id: string, visible: boolean) => boolean;
    }).__p3SetPanelVisible;
    expect(setVisible(linerMesh!.name.slice('fold-panel:'.length), false)).toBe(true);
    expect(linerMesh!.visible).toBe(false);
    expect(setVisible(
      (linerMesh!.userData.panelId as string).slice('liner:'.length),
      true,
    )).toBe(false);

    scene.replaceScene(offScene);
    expect(activePanelMeshes().some(
      (mesh) => mesh.name.startsWith('fold-panel:liner:'),
    )).toBe(false);
    expect(linerMesh!.parent?.parent).toBeNull();
    scene.dispose();
  }, 30_000);

  it('writes mesh positions only from renderedVerticesByPanel after applying assembly delta', () => {
    mockCanvasContext();
    const model = singleHingedModel();
    const resolved: ResolvedSceneSpec = {
      pieces: [{
        pieceId: 'piece-a',
        model,
        foldWindow: [0, 0.5],
        assemblyTrack: [{
          time: 1,
          position: { x: 10, y: 20, z: 30 },
          quaternion: IDENTITY,
        }],
      }],
    };
    const scene = createFoldScene(document.createElement('canvas'));
    scene.replaceScene(resolved, { thickness: 0.5 });
    scene.updatePose(1);

    const piece = resolved.pieces[0]!;
    const evaluated = evaluateResolvedScenePiecePose(piece, 1);
    const context = createPanelRenderPoseContext(
      model,
      evaluated.foldAngles,
      0.5,
    );
    const panel = model.panels.find(({ id }) => id === 'topLid')!;
    const rendered = context.renderedVerticesByPanel.get(panel.id)!
      .map((point) => applyTransform(evaluated.assemblyDelta, point));
    const expected = panelSolidPositions(
      rendered,
      earClipIndices(panel.polygon),
      0.5,
    );
    const mesh = activePanelMeshes().find(
      ({ name }) => name === 'fold-panel:piece-a:topLid',
    )!;
    const actual = (
      mesh.geometry.getAttribute('position') as BufferAttribute
    ).array;

    expect([...actual]).toEqual([...expected]);
    expect(rendered[0]!.x).toBeGreaterThan(10);
    scene.dispose();
  });

  it('fits the camera to transient assembly-track extrema instead of only flat and final poses', () => {
    const model = singleHingedModel();
    const resolved: ResolvedSceneSpec = {
      pieces: [{
        pieceId: 'moving',
        model,
        foldWindow: [0, 0.2],
        assemblyTrack: [
          {
            time: 0.6,
            position: { x: 500, y: 0, z: 0 },
            quaternion: IDENTITY,
          },
          {
            time: 1,
            position: { x: 0, y: 0, z: 0 },
            quaternion: IDENTITY,
          },
        ],
      }],
    };

    const frame = computeSceneCameraFrame(resolved, 0.5);

    expect(frame).not.toBeNull();
    expect(frame!.fitDiagonal).toBeGreaterThan(490);
    expect(frame!.focusDiagonal).toBeLessThan(10);
  });
});
