import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec3 } from '../fold/pose3d';
import { worldGeometry } from '../fold/pose3d';
import { foldPose } from '../fold/schedule';
import type { FoldModel } from '../fold/types';

const PAPER_FALLBACK = '#FAF7F0'; // Source: src/styles/tokens.css --paper.
const CARD_COLOR = 0xffffff;
const CARD_ROUGHNESS = 0.9;
const CARD_METALNESS = 0;
const CAMERA_FOV_DEGREES = 35;
const CAMERA_FIT_DISTANCE_FACTOR = 2;
const CAMERA_ELEVATION_FACTOR = 0.28;
const CAMERA_NEAR_FACTOR = 0.001;
const CAMERA_FAR_FACTOR = 10;
const MIN_SCENE_SCALE = 1;
const MAX_PIXEL_RATIO = 2;
const AMBIENT_LIGHT_INTENSITY = 1.5;
const KEY_LIGHT_INTENSITY = 24;
const FILL_LIGHT_INTENSITY = 12;
const SHADOW_TEXTURE_SIZE = 256;
const SHADOW_PADDING_FACTOR = 1.18;
const SHADOW_MIN_SPAN_FACTOR = 0.35;
const SHADOW_Z_OFFSET_FACTOR = 0.003;
const DIELINE_TO_THREE_Y = -1;

function mapDielineY(y: number): number {
  if (y === 0) return 0;
  return y * DIELINE_TO_THREE_Y;
}

function writeThreeVertex(
  positions: Float32Array,
  offset: number,
  vertex: Vec3,
): void {
  positions[offset] = vertex.x;
  positions[offset + 1] = mapDielineY(vertex.y);
  positions[offset + 2] = vertex.z;
}

export interface FoldSceneOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onUserInteract?: () => void;
}

export interface FoldSceneHandle {
  updatePose(t: number): void;
  replaceModel(model: FoldModel): void;
  setAutoRotate(on: boolean): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

interface GeometryBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface ContactShadow {
  geometry: PlaneGeometry;
  material: MeshBasicMaterial;
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  texture: CanvasTexture;
}

/**
 * Fan-triangulates panel vertices while mapping dieline coordinates to Three.js.
 * Dielines use y-down coordinates; Three.js uses y-up, so y is always negated.
 */
export function panelGeometryPositions(worldVertices: Vec3[]): Float32Array {
  const triangleCount = Math.max(0, worldVertices.length - 2);
  const positions = new Float32Array(triangleCount * 9);
  const firstVertex = worldVertices[0];

  if (!firstVertex) return positions;

  let offset = 0;
  for (let index = 1; index < worldVertices.length - 1; index += 1) {
    writeThreeVertex(positions, offset, firstVertex);
    writeThreeVertex(positions, offset + 3, worldVertices[index]!);
    writeThreeVertex(positions, offset + 6, worldVertices[index + 1]!);
    offset += 9;
  }

  return positions;
}

function paperColor(): Color {
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue('--paper')
    .trim();
  return new Color(token || PAPER_FALLBACK);
}

function createCardMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: CARD_COLOR,
    metalness: CARD_METALNESS,
    roughness: CARD_ROUGHNESS,
    side: DoubleSide,
  });
}

function createContactShadow(): ContactShadow {
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_TEXTURE_SIZE;
  canvas.height = SHADOW_TEXTURE_SIZE;

  const context = canvas.getContext('2d');
  if (context) {
    const center = SHADOW_TEXTURE_SIZE / 2;
    const gradient = context.createRadialGradient(
      center,
      center,
      0,
      center,
      center,
      center,
    );
    gradient.addColorStop(0, 'rgba(25, 23, 18, 0.24)');
    gradient.addColorStop(0.48, 'rgba(25, 23, 18, 0.12)');
    gradient.addColorStop(1, 'rgba(25, 23, 18, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);
  }

  const texture = new CanvasTexture(canvas);
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicMaterial({
    depthWrite: false,
    map: texture,
    side: DoubleSide,
    transparent: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'fold-contact-shadow';
  mesh.renderOrder = -1;

  return { geometry, material, mesh, texture };
}

function disposeContactShadow(shadow: ContactShadow): void {
  shadow.geometry.dispose();
  shadow.material.dispose();
  shadow.texture.dispose();
}

function boundsForGeometry(
  geometryByPanel: Map<string, Vec3[]>,
): GeometryBounds | null {
  let bounds: GeometryBounds | null = null;

  for (const vertices of geometryByPanel.values()) {
    for (const vertex of vertices) {
      const y = mapDielineY(vertex.y);
      if (!bounds) {
        bounds = {
          minX: vertex.x,
          maxX: vertex.x,
          minY: y,
          maxY: y,
          minZ: vertex.z,
          maxZ: vertex.z,
        };
        continue;
      }

      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, vertex.z);
      bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
    }
  }

  return bounds;
}

function boundsDiagonal(bounds: GeometryBounds): number {
  return Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
}

/**
 * Creates a FoldModel-driven Three.js scene with an on-demand render loop.
 */
export function createFoldScene(
  canvas: HTMLCanvasElement,
  opts: FoldSceneOptions = {},
): FoldSceneHandle {
  let viewportWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
  let viewportHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);

  const createRenderer = (): WebGLRenderer => {
    const nextRenderer = new WebGLRenderer({ canvas, antialias: true });
    nextRenderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    );
    nextRenderer.setSize(viewportWidth, viewportHeight, false);
    return nextRenderer;
  };

  let renderer = createRenderer();
  const scene = new Scene();
  scene.background = paperColor();

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    viewportWidth / viewportHeight,
    0.1,
    100,
  );
  camera.position.set(0, 1.5, 4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  const ambient = new AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY);
  const keyLight = new PointLight(0xffffff, KEY_LIGHT_INTENSITY);
  const fillLight = new PointLight(0xdde8ff, FILL_LIGHT_INTENSITY);
  const keyLightOffset = new Vector3(-0.42, 0.48, -0.58);
  const fillLightOffset = new Vector3(0.52, 0.08, -0.36);
  scene.add(ambient, keyLight, fillLight);

  const panelRoot = new Group();
  panelRoot.name = 'fold-panel-root';
  scene.add(panelRoot);

  let contactShadow = createContactShadow();
  scene.add(contactShadow.mesh);

  const panelMeshes = new Map<
    string,
    Mesh<BufferGeometry, MeshStandardMaterial>
  >();
  let panelMaterial: MeshStandardMaterial | null = null;
  let currentModel: FoldModel | null = null;
  let currentT = 0;
  let frameId: number | null = null;
  let needsRender = true;
  let contextLost = false;
  let disposed = false;

  const disposePanelTree = (): void => {
    for (const mesh of panelMeshes.values()) {
      mesh.geometry.dispose();
    }
    panelMeshes.clear();
    panelRoot.clear();
    panelMaterial?.dispose();
    panelMaterial = null;
  };

  const buildPanelTree = (model: FoldModel): void => {
    panelMaterial = createCardMaterial();

    for (const panel of model.panels) {
      const geometry = new BufferGeometry();
      const positionCount = Math.max(0, panel.polygon.length - 2) * 9;
      const positions = new Float32Array(positionCount);
      geometry.setAttribute('position', new BufferAttribute(positions, 3));

      const mesh = new Mesh(geometry, panelMaterial);
      mesh.name = `fold-panel:${panel.id}`;
      mesh.userData.panelId = panel.id;
      panelMeshes.set(panel.id, mesh);
      panelRoot.add(mesh);
    }
  };

  const updateContactShadow = (bounds: GeometryBounds): void => {
    const diagonal = Math.max(boundsDiagonal(bounds), MIN_SCENE_SCALE);
    const width = Math.max(
      (bounds.maxX - bounds.minX) * SHADOW_PADDING_FACTOR,
      diagonal * SHADOW_MIN_SPAN_FACTOR,
    );
    const height = Math.max(
      (bounds.maxY - bounds.minY) * SHADOW_PADDING_FACTOR,
      diagonal * SHADOW_MIN_SPAN_FACTOR,
    );

    contactShadow.mesh.position.set(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      bounds.minZ - diagonal * SHADOW_Z_OFFSET_FACTOR,
    );
    contactShadow.mesh.scale.set(width, height, 1);
  };

  const updateModelPose = (): GeometryBounds | null => {
    if (!currentModel) return null;

    const pose = foldPose(currentT, currentModel);
    const geometryByPanel = worldGeometry(currentModel, pose);

    for (const panel of currentModel.panels) {
      const mesh = panelMeshes.get(panel.id);
      const vertices = geometryByPanel.get(panel.id);
      if (!mesh || !vertices) continue;

      const attribute = mesh.geometry.getAttribute('position') as BufferAttribute;
      attribute.copyArray(panelGeometryPositions(vertices));
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }

    const bounds = boundsForGeometry(geometryByPanel);
    if (bounds) updateContactShadow(bounds);
    needsRender = true;
    return bounds;
  };

  const fitCamera = (bounds: GeometryBounds): void => {
    const diagonal = Math.max(boundsDiagonal(bounds), MIN_SCENE_SCALE);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const cameraDistance = diagonal * CAMERA_FIT_DISTANCE_FACTOR;

    controls.target.set(centerX, centerY, centerZ);
    camera.position.set(
      centerX,
      centerY + diagonal * CAMERA_ELEVATION_FACTOR,
      centerZ + cameraDistance,
    );
    camera.near = Math.max(diagonal * CAMERA_NEAR_FACTOR, 0.01);
    camera.far = Math.max(diagonal * CAMERA_FAR_FACTOR, 100);
    camera.updateProjectionMatrix();
    controls.minDistance = diagonal * 0.2;
    controls.maxDistance = diagonal * 6;
    controls.update();
  };

  const updateLightRig = (): void => {
    const distance = Math.max(
      camera.position.distanceTo(controls.target),
      MIN_SCENE_SCALE,
    );
    const intensityScale = distance * distance;

    // Codrops camera-relative rig: offsets rotate with the camera quaternion.
    keyLight.position
      .copy(keyLightOffset)
      .multiplyScalar(distance)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);
    fillLight.position
      .copy(fillLightOffset)
      .multiplyScalar(distance)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);
    keyLight.intensity = KEY_LIGHT_INTENSITY * intensityScale;
    fillLight.intensity = FILL_LIGHT_INTENSITY * intensityScale;
  };

  const renderFrame = (): void => {
    frameId = null;
    if (disposed || contextLost) return;

    const controlsChanged = controls.update();
    if (needsRender || controlsChanged || controls.autoRotate) {
      updateLightRig();
      renderer.render(scene, camera);
      needsRender = false;
    }

    if (controlsChanged || controls.autoRotate) scheduleRender();
  };

  function scheduleRender(): void {
    if (disposed || contextLost || frameId !== null) return;
    frameId = requestAnimationFrame(renderFrame);
  }

  const markNeedsRender = (): void => {
    needsRender = true;
    scheduleRender();
  };

  const resize = (width: number, height: number): void => {
    viewportWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
    viewportHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
    camera.aspect = viewportWidth / viewportHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewportWidth, viewportHeight, false);
    markNeedsRender();
  };

  const onControlsChange = (): void => markNeedsRender();
  const onControlsStart = (): void => {
    controls.autoRotate = false;
    opts.onUserInteract?.();
    markNeedsRender();
  };
  controls.addEventListener('change', onControlsChange);
  controls.addEventListener('start', onControlsStart);

  const cancelRenderLoop = (): void => {
    if (frameId === null) return;
    cancelAnimationFrame(frameId);
    frameId = null;
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed) return;
    contextLost = true;
    cancelRenderLoop();
    opts.onContextLost?.();
  };

  const onContextRestored = (): void => {
    if (disposed) return;

    renderer.dispose();
    renderer = createRenderer();

    scene.remove(contactShadow.mesh);
    disposeContactShadow(contactShadow);
    contactShadow = createContactShadow();
    scene.add(contactShadow.mesh);

    scene.remove(panelRoot);
    disposePanelTree();
    if (currentModel) {
      buildPanelTree(currentModel);
      updateModelPose();
    }
    scene.add(panelRoot);

    contextLost = false;
    markNeedsRender();
    opts.onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  scheduleRender();

  return {
    updatePose(t) {
      currentT = Number.isFinite(t) ? t : 0;
      updateModelPose();
      scheduleRender();
    },
    replaceModel(model) {
      currentModel = model;
      disposePanelTree();
      buildPanelTree(model);
      const bounds = updateModelPose();
      if (bounds) fitCamera(bounds);
      markNeedsRender();
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
      markNeedsRender();
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRenderLoop();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      controls.removeEventListener('change', onControlsChange);
      controls.removeEventListener('start', onControlsStart);
      controls.dispose();
      disposePanelTree();
      disposeContactShadow(contactShadow);
      scene.clear();
      renderer.dispose();
      currentModel = null;
    },
  };
}
