import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import {
  TELESCOPE_ASSEMBLY_WINDOWS,
  TELESCOPE_FOLD_WINDOWS,
  TELESCOPE_FOLD_WINDOWS_OFF,
  buildTelescopeSceneSpec,
} from '@/fold/models/telescope';
import type {
  FoldScenePiece,
  FoldSceneSpec,
} from '@/fold/scene-spec';
import {
  telescopeAssemblyClearanceViolations,
  telescopeAssemblyOracleViolations,
  telescopeRuntimeManifest,
} from '../helpers/telescope-assembly-oracle';

function replacePiece(
  scene: FoldSceneSpec,
  pieceId: string,
  replace: (piece: FoldScenePiece) => FoldScenePiece,
): FoldSceneSpec {
  return {
    pieces: scene.pieces.map((piece) =>
      piece.pieceId === pieceId ? replace(piece) : piece),
  };
}

describe('Telescope assembly tracks', () => {
  it('on 態以幕一三拍裝 liner，再以幕二 F3 四拍裝 lid', () => {
    const params = resolveParams(telescope);
    const scene = buildTelescopeSceneSpec(params);
    const base = scene.pieces.find(({ pieceId }) => pieceId === 'base')!;
    const liner = scene.pieces.find(({ pieceId }) => pieceId === 'liner')!;
    const lid = scene.pieces.find(({ pieceId }) => pieceId === 'lid')!;

    expect(base.assemblyTrack).toEqual([]);
    expect(liner.assemblyTrack.map(({ time }) => time))
      .toEqual([...TELESCOPE_ASSEMBLY_WINDOWS.liner]);
    expect(lid.assemblyTrack.map(({ time }) => time))
      .toEqual([...TELESCOPE_ASSEMBLY_WINDOWS.lid]);
    expect(liner.assemblyTrack[0]!.position)
      .toEqual({ x: 0, y: 0, z: 0 });
    expect(lid.assemblyTrack[0]!.position)
      .toEqual({ x: 0, y: 0, z: 0 });
    expect(lid.assemblyTrack[2]!.quaternion)
      .toEqual({ x: 1, y: 0, z: 0, w: 0 });
  });

  it('AC-T4b ⓪-④ 與 AC-T4 全組裝段在 on 態通過', () => {
    const params = resolveParams(telescope);
    const scene = buildTelescopeSceneSpec(params);
    expect(telescopeAssemblyOracleViolations(scene, params)).toEqual([]);
    expect(telescopeAssemblyClearanceViolations(scene, params)).toEqual([]);
  }, 30_000);

  it('oracle sabotage：錯翻軸與錯 z 序都 fail-loud', () => {
    const params = resolveParams(telescope);
    const scene = buildTelescopeSceneSpec(params);
    const wrongAxis = replacePiece(scene, 'lid', (piece) => ({
      ...piece,
      assemblyTrack: piece.assemblyTrack.map((keyframe, index) =>
        index < 2
          ? keyframe
          : {
            ...keyframe,
            quaternion: { x: 0, y: 1, z: 0, w: 0 },
          }),
    }));
    expect(telescopeAssemblyOracleViolations(wrongAxis, params))
      .toContainEqual(expect.stringContaining('⓪'));

    const wrongZ = replacePiece(scene, 'lid', (piece) => ({
      ...piece,
      assemblyTrack: piece.assemblyTrack.map((keyframe, index, all) =>
        index !== all.length - 1
          ? keyframe
          : {
            ...keyframe,
            position: {
              ...keyframe.position,
              z: keyframe.position.z + 2,
            },
          }),
    }));
    expect(telescopeAssemblyOracleViolations(wrongZ, params))
      .toContainEqual(expect.stringContaining('③'));
  });

  it('clearance sabotage：取消抬升並穿過 base 會被逐拍掃描抓到', () => {
    const params = resolveParams(telescope);
    const scene = buildTelescopeSceneSpec(params);
    const lid = scene.pieces.find(({ pieceId }) => pieceId === 'lid')!;
    const finalPosition = lid.assemblyTrack.at(-1)!.position;
    const broken = replacePiece(scene, 'lid', (piece) => ({
      ...piece,
      assemblyTrack: piece.assemblyTrack.map((keyframe, index) =>
        index === 2
          ? {
            ...keyframe,
            position: {
              ...finalPosition,
              z: finalPosition.z / 2,
            },
          }
          : keyframe),
    }));
    expect(telescopeAssemblyClearanceViolations(broken, params))
      .not.toEqual([]);
  }, 30_000);

  it('liner seating corridor 不是 blanket skip：水平越界仍 fail-loud', () => {
    const params = resolveParams(telescope);
    const scene = buildTelescopeSceneSpec(params);
    const broken = replacePiece(scene, 'liner', (piece) => ({
      ...piece,
      assemblyTrack: piece.assemblyTrack.map((keyframe, index) =>
        index < 2
          ? keyframe
          : {
            ...keyframe,
            position: {
              ...keyframe.position,
              x: keyframe.position.x + 200,
            },
          }),
    }));
    expect(telescopeAssemblyClearanceViolations(broken, params))
      .toContainEqual(expect.stringContaining('seating corridor'));
  }, 30_000);

  it('off 態展寬摺窗並讓 liner 在六種 runtime 集合零殘留', () => {
    const params = resolveParams(telescope, { linerEnabled: false });
    const scene = buildTelescopeSceneSpec(params);
    expect(scene.pieces.map(({ pieceId }) => pieceId).sort())
      .toEqual(['base', 'lid']);
    expect(scene.pieces.find(({ pieceId }) => pieceId === 'base')!.foldWindow)
      .toEqual([...TELESCOPE_FOLD_WINDOWS_OFF.base]);
    expect(scene.pieces.find(({ pieceId }) => pieceId === 'lid')!.foldWindow)
      .toEqual([...TELESCOPE_FOLD_WINDOWS_OFF.lid]);
    expect(
      TELESCOPE_FOLD_WINDOWS_OFF.base[1] - TELESCOPE_FOLD_WINDOWS_OFF.base[0],
    ).toBeGreaterThan(
      TELESCOPE_FOLD_WINDOWS.base[1] - TELESCOPE_FOLD_WINDOWS.base[0],
    );
    expect(
      TELESCOPE_FOLD_WINDOWS_OFF.lid[1] - TELESCOPE_FOLD_WINDOWS_OFF.lid[0],
    ).toBeGreaterThan(
      TELESCOPE_FOLD_WINDOWS.lid[1] - TELESCOPE_FOLD_WINDOWS.lid[0],
    );

    const manifest = telescopeRuntimeManifest(scene, params);
    for (const [kind, ids] of Object.entries(manifest)) {
      expect(
        (ids as string[]).filter((id: string) =>
          id.toLowerCase().includes('liner')),
        `${kind} 不得殘留 liner`,
      ).toEqual([]);
    }
    expect(telescopeAssemblyOracleViolations(scene, params)).toEqual([]);
    expect(telescopeAssemblyClearanceViolations(scene, params)).toEqual([]);
  }, 30_000);
});
