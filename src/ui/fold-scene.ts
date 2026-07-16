// @ts-expect-error -- three@0.185.1 is pinned without @types/three in this spike's fixed dependency set.
import { AmbientLight, BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, PerspectiveCamera, PointLight, Scene, WebGLRenderer } from 'three';
// @ts-expect-error -- OrbitControls declarations are supplied by the same absent @types/three package.
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FoldModel } from '../fold/types';

export interface FoldSceneOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export interface FoldSceneHandle {
  updatePose(t: number): void;
  replaceModel(model: FoldModel): void;
  setAutoRotate(on: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Minimal Three.js scene used by the J1 bundle spike. The placeholder mesh is
 * intentionally replaced by FoldModel-driven geometry in T3.
 */
export function createFoldScene(
  canvas: HTMLCanvasElement,
  opts: FoldSceneOptions = {},
): FoldSceneHandle {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene();
  scene.background = new Color(0xf7f4ec);

  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 1.5, 4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const ambient = new AmbientLight(0xffffff, 1.5);
  const keyLight = new PointLight(0xffffff, 24);
  keyLight.position.set(3, 4, 5);
  const fillLight = new PointLight(0xdde8ff, 12);
  fillLight.position.set(-3, 1, 2);
  scene.add(ambient, keyLight, fillLight);

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        -1, -0.7, 0,
        1, -0.7, 0,
        1, 0.7, 0,
        -1, -0.7, 0,
        1, 0.7, 0,
        -1, 0.7, 0,
      ]),
      3,
    ),
  );
  geometry.computeVertexNormals();

  const material = new MeshStandardMaterial({ color: 0xc7a36a, roughness: 0.72, metalness: 0 });
  const testMesh = new Mesh(geometry, material);
  scene.add(testMesh);

  const resize = (width: number, height: number): void => {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    camera.aspect = safeWidth / safeHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(safeWidth, safeHeight, false);
  };
  resize(canvas.clientWidth || canvas.width || 1, canvas.clientHeight || canvas.height || 1);

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    opts.onContextLost?.();
  };
  const onContextRestored = (): void => opts.onContextRestored?.();
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  let frameId = 0;
  let disposed = false;
  const renderFrame = (): void => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    frameId = requestAnimationFrame(renderFrame);
  };
  frameId = requestAnimationFrame(renderFrame);

  return {
    updatePose(t) {
      const progress = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
      testMesh.rotation.x = progress * Math.PI * 0.12;
      testMesh.rotation.y = progress * Math.PI * 0.5;
    },
    replaceModel(model) {
      testMesh.userData.foldModel = model;
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      delete testMesh.userData.foldModel;
      scene.clear();
      renderer.dispose();
    },
  };
}
