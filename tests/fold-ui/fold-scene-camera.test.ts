import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import {
  cameraOrbitPosition,
  cameraPlacement,
  computeSceneCameraFrame,
  shadowPlacement,
  type GeometryBounds,
} from '@/ui/fold-scene';
import { resolveFoldSceneSpec } from '@/fold/scene-spec';
import { telescope } from '@/boxes/telescope';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';

const params = resolveParams(reverseTuckEnd, {});
const telescopeParams = resolveParams(telescope, {});
const model = buildRteFoldModel(params);
const L = params.L as number;
const W = params.W as number;
const D = params.D as number;
const thickness = params.thickness as number;
// 以 computeSceneCameraFrame 驗證單片 scene；此包裝與 replaceModel 使用
// 相同場景路徑。
const singlePieceScene = resolveFoldSceneSpec(
  {
    pieces: [
      {
        pieceId: 'model',
        buildModel: () => model,
        foldWindow: [0, 1],
        assemblyTrack: [],
      },
    ],
  },
  params,
);
const computeFrame = () => computeSceneCameraFrame(singlePieceScene, thickness);

function boundsAt(t: number): GeometryBounds {
  const geometry = worldGeometry(model, foldPose(t, model));
  const bounds: GeometryBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };

  for (const vertices of geometry.values()) {
    for (const vertex of vertices) {
      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.minY = Math.min(bounds.minY, -vertex.y);
      bounds.maxY = Math.max(bounds.maxY, -vertex.y);
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

describe('computeSceneCameraFrame（單片包裝·production 路徑）', () => {
  it('normalizes the completed box center to the stable scene origin', () => {
    const frame = computeFrame()!;
    const foldedBounds = boundsAt(1);
    const foldedCenter = {
      x: (foldedBounds.minX + foldedBounds.maxX) / 2,
      y: (foldedBounds.minY + foldedBounds.maxY) / 2,
      z: (foldedBounds.minZ + foldedBounds.maxZ) / 2,
    };

    expect(frame.target).toEqual({ x: 0, y: 0, z: 0 });
    // renderedVerticesByPanel 聚合值與 worldGeometry 直算存在 ~1e-14 浮點
    // 尾差，逐軸用 closeTo。
    expect(frame.modelOffset.x).toBeCloseTo(-foldedCenter.x, 10);
    expect(frame.modelOffset.y).toBeCloseTo(-foldedCenter.y, 10);
    expect(frame.modelOffset.z).toBeCloseTo(-foldedCenter.z, 10);

    const tolerance = Math.max(2 * thickness, 1);
    expect(Math.abs(foldedCenter.x - L / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(foldedCenter.y - -D / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(foldedCenter.z + W / 2)).toBeLessThanOrEqual(tolerance);
  });

  it('取景對角線涵蓋攤平全紙、聚焦對角線貼近盒體（近縮放不被大紙鎖死）', () => {
    const frame = computeFrame()!;

    // 攤平外廓直接由 2D 多邊形計算（t=0 世界幾何＝多邊形原位·y 取負·z=0），
    // 與實作的 worldGeometry 路徑獨立。
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const panel of model.panels) {
      for (const { x, y } of panel.polygon) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, -y);
        maxY = Math.max(maxY, -y);
      }
    }
    const flatDiagonal = Math.hypot(maxX - minX, maxY - minY);
    const boxDiagonal = Math.hypot(L, W, D);

    expect(frame.fitDiagonal).toBeGreaterThanOrEqual(flatDiagonal);
    expect(Math.abs(frame.focusDiagonal - boxDiagonal)).toBeLessThanOrEqual(Math.max(4 * thickness, 5));
    expect(frame.focusDiagonal).toBeLessThanOrEqual(frame.fitDiagonal);
  });
});

describe('cameraPlacement（預設取景以折後盒體定距）', () => {
  const frame = computeFrame()!;

  it('距離只由 focusDiagonal 決定——攤平外廓變大不得把成品推遠', () => {
    const placement = cameraPlacement(frame);
    // 判別性：把攤平外廓加倍（例如多片並排的盒型），距離必須原地不動。
    // 舊行為以 fitDiagonal 定距，這一條會直接把距離也加倍。
    const widerFlat = cameraPlacement({ ...frame, fitDiagonal: frame.fitDiagonal * 2 });

    expect(widerFlat.distance).toBeCloseTo(placement.distance, 10);
    expect(placement.distance).toBeCloseTo(
      frame.focusDiagonal * Math.hypot(2, 0.28),
      6,
    );
  });

  it('縮遠仍看得完整張攤平紙——far/maxDistance 續由 fitDiagonal 決定', () => {
    const placement = cameraPlacement(frame);

    // 攤平時整張紙要進得了畫面 ⇒ 可到達的最遠視距，必須至少等於
    // **app 自己用來取景攤平外廓的那個距離**（同一組 fit/elevation 常數）。
    // ⚠ 原本寫的是 `> fitDiagonal`，那只是不等式護欄不是契約：把 maxDistance
    // 改吃 focusDiagonal（= 1411mm）仍然大於 fitDiagonal（994.5mm）而照過，
    // 但取景攤平紙需要 2008mm——使用者實際上已經縮不遠到看完整張紙了。
    const flatFramingDistance = (f: typeof frame) => f.fitDiagonal * Math.hypot(2, 0.28);
    expect(placement.maxDistance).toBeGreaterThanOrEqual(flatFramingDistance(frame));
    // 判別性：RTE 的攤平紙只比盒體大一點，fit/focus 比撐不出差異。契約對**任何**
    // frame 都要成立，所以另取一個攤平外廓遠大於盒體的 frame（telescope 實際是 4.23×）。
    const wideFlat = { ...frame, fitDiagonal: frame.focusDiagonal * 10 };
    expect(
      cameraPlacement(wideFlat).maxDistance,
      '攤平紙遠大於盒體時，縮遠上限仍必須到得了取景攤平紙的距離',
    ).toBeGreaterThanOrEqual(flatFramingDistance(wideFlat));
    // far 也要蓋得住「相機退到最遠 ＋ 紙張本身深度」。
    expect(placement.far).toBeGreaterThan(placement.maxDistance + frame.fitDiagonal);
    // 近端不被大紙鎖死的原契約不變。
    expect(placement.minDistance).toBeCloseTo(frame.focusDiagonal * 0.2, 10);
    expect(placement.near).toBeCloseTo(frame.focusDiagonal * 0.005, 10);
  });

  it('俯角不隨盒子大小改變（距離與抬升同比例縮放）', () => {
    const small = cameraPlacement({ ...frame, focusDiagonal: 40 });
    const large = cameraPlacement({ ...frame, focusDiagonal: 400 });

    const angle = (p: ReturnType<typeof cameraPlacement>) => Math.atan2(
      p.position.y - frame.target.y,
      p.position.z - frame.target.z,
    );
    expect(angle(small)).toBeCloseTo(angle(large), 12);
    expect(angle(small)).toBeCloseTo(Math.atan2(0.28, 2), 12);
  });

  it('telescope 預設視距嚴格近於攤平取景——revert 會當場紅', () => {
    const telescopeFrame = computeSceneCameraFrame(
      resolveFoldSceneSpec(
        buildTelescopeSceneSpec(telescopeParams),
        telescopeParams,
      ),
      telescopeParams.thickness as number,
    )!;
    const placement = cameraPlacement(telescopeFrame);

    // ⚠ 這裡**刻意不放一個 mm 門檻**。俯視殘餘的成因是次像素視差，它同時隨
    // 盒體尺寸、裝置像素比與畫布大小變化——實測預設列 dsf=2 得 0px、dsf=1 得 328px，
    // 而 600mm 盒即使在正確取景下仍有殘餘。任何「距離 ≤ N mm 就安全」的常數都會
    // 把一個多變數現象壓成單一數字，並暗示一個我自己的資料就推翻的保證。
    // 真正的判準是像素層的 `e2e/fold-showthrough.spec.ts`（跨三個尺寸列）。
    // 此處只留一條無魔數的回歸絆線：取景必須仍錨在折後盒體上。
    expect(placement.distance).toBeLessThan(telescopeFrame.fitDiagonal);
  });
});

describe('cameraOrbitPosition', () => {
  it('orbits around the frame target while preserving the fitted distance', () => {
    const target = { x: 10, y: -4, z: 3 };
    const distance = 120;
    const position = cameraOrbitPosition(target, distance, 35, 25);

    expect(Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    )).toBeCloseTo(distance, 10);
    expect(position.x).toBeGreaterThan(target.x);
    expect(position.y).toBeGreaterThan(target.y);
    expect(position.z).toBeGreaterThan(target.z);
  });
});

describe('shadowPlacement', () => {
  it('places the contact shadow below the folded box bottom by the diagonal offset', () => {
    const bounds = boundsAt(1);
    const diagonal = Math.max(boundsDiagonal(bounds), 1);
    const placement = shadowPlacement(bounds);

    expect(placement.center).toEqual({
      x: (bounds.minX + bounds.maxX) / 2,
      y: bounds.minY - diagonal * 0.003,
      z: (bounds.minZ + bounds.maxZ) / 2,
    });
  });

  it('derives its width and height from the x/z footprint rather than x/y', () => {
    const bounds = boundsAt(1);
    const diagonal = Math.max(boundsDiagonal(bounds), 1);
    const minSpan = diagonal * 0.35;
    const placement = shadowPlacement(bounds);
    const expectedZHeight = Math.max((bounds.maxZ - bounds.minZ) * 1.18, minSpan);
    const oldYHeight = Math.max((bounds.maxY - bounds.minY) * 1.18, minSpan);

    expect(placement.size.w).toBe(Math.max((bounds.maxX - bounds.minX) * 1.18, minSpan));
    expect(placement.size.h).toBe(expectedZHeight);
    expect(placement.size.h).not.toBe(oldYHeight);
  });

  it('keeps a valid minimum footprint for the flat pose', () => {
    const bounds = boundsAt(0);
    const minimumSpan = Math.max(boundsDiagonal(bounds), 1) * 0.35;

    expect(() => shadowPlacement(bounds)).not.toThrow();
    expect(shadowPlacement(bounds).size.w).toBeGreaterThanOrEqual(minimumSpan);
    expect(shadowPlacement(bounds).size.h).toBeGreaterThanOrEqual(minimumSpan);
  });
});
