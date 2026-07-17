import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel } from '@/fold/types';
import { t } from '@/i18n/t';
import type { createFoldScene, FoldSceneHandle } from '@/ui/fold-scene';

const defaultLoadScene = () => import('./fold-scene');
const FOLD_PLAY_DURATION_MS = 2400;

type FoldModelBuilder = (values: ResolvedParams) => FoldModel;

interface FoldModelRuntime {
  builders: Record<string, FoldModelBuilder>;
  validate: (model: FoldModel) => string[];
}

async function loadFoldModelRuntime(): Promise<FoldModelRuntime> {
  const [registry, validation] = await Promise.all([
    import('@/fold/registry'),
    import('@/fold/validate'),
  ]);
  return {
    builders: registry.FOLD_MODEL_BUILDERS,
    validate: validation.validateFoldModel,
  };
}

export interface FoldViewProps {
  boxId: string;
  values: ResolvedParams;
  createScene?: typeof createFoldScene;
  loadScene?: () => Promise<{ createFoldScene: typeof createFoldScene }>;
}

function FoldEmpty({ copy }: { copy: string }) {
  return (
    <div className="fold-empty">
      <p className="mono">{copy}</p>
    </div>
  );
}

export function FoldView({ boxId, values, createScene, loadScene }: FoldViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<FoldSceneHandle | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playbackStartedAtRef = useRef<number | null>(null);
  const playbackOriginRef = useRef(1);
  const foldProgressRef = useRef(1);
  // 自轉預設關閉（2026-07-17 E2E 驗收裁決）：進場靜止，由使用者主動開啟。
  const autoRotateRef = useRef(false);
  const [foldProgress, setFoldProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  // dynamic chunk（model runtime 或 fold-scene）載入失敗：藏控制列與 canvas、render 空狀態殼
  //（final review F2——否則空白或死 UI）。M1 不出新文案（copy checkpoint 前置）；失敗態
  // 文案 key 提案（fold.loadFailed）待終裁後補。切走再進＝remount 重試。
  const [loadFailed, setLoadFailed] = useState(false);
  const [modelRuntime, setModelRuntime] = useState<FoldModelRuntime | null>(null);
  const builder = modelRuntime?.builders[boxId];
  const model = useMemo<FoldModel | undefined>(() => builder?.(values), [boxId, values, builder]);
  const validationErrors = useMemo(
    () => model === undefined ? [] : modelRuntime?.validate(model) ?? [],
    [model, modelRuntime],
  );
  const canCreateScene = model !== undefined && validationErrors.length === 0;
  const modelRef = useRef(model);
  modelRef.current = model;
  const thickness = values.thickness as number;
  const thicknessRef = useRef(thickness);
  thicknessRef.current = thickness;

  const updateFoldProgress = (nextProgress: number): void => {
    const progress = Math.min(1, Math.max(0, nextProgress));
    foldProgressRef.current = progress;
    setFoldProgress(progress);
    sceneRef.current?.updatePose(progress);
  };

  const cancelPlaybackFrame = (): void => {
    if (animationFrameRef.current === null) return;
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  };

  const stopPlayback = (): void => {
    cancelPlaybackFrame();
    playbackStartedAtRef.current = null;
    setPlaying(false);
  };

  const advancePlayback = (timestamp: number): void => {
    animationFrameRef.current = null;
    playbackStartedAtRef.current ??= timestamp;
    const elapsed = timestamp - playbackStartedAtRef.current;
    const progress = Math.min(1, playbackOriginRef.current + elapsed / FOLD_PLAY_DURATION_MS);
    updateFoldProgress(progress);
    if (progress >= 1) {
      playbackStartedAtRef.current = null;
      setPlaying(false);
      return;
    }
    animationFrameRef.current = requestAnimationFrame(advancePlayback);
  };

  const togglePlayback = (): void => {
    if (playing) {
      stopPlayback();
      return;
    }
    const startProgress = foldProgressRef.current >= 1 ? 0 : foldProgressRef.current;
    if (startProgress === 0) updateFoldProgress(0);
    playbackOriginRef.current = startProgress;
    playbackStartedAtRef.current = null;
    setPlaying(true);
    animationFrameRef.current = requestAnimationFrame(advancePlayback);
  };

  useEffect(() => {
    let cancelled = false;
    loadFoldModelRuntime()
      .then((runtime) => {
        if (!cancelled) setModelRuntime(runtime);
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => cancelPlaybackFrame(), []);

  useEffect(() => {
    if (validationErrors.length > 0) console.error(validationErrors);
  }, [validationErrors]);

  useEffect(() => {
    if (canCreateScene && model !== undefined) {
      sceneRef.current?.replaceModel(model, { thickness });
    }
  }, [canCreateScene, model, thickness]);

  useEffect(() => {
    if (!canCreateScene) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;

    let cancelled = false;
    let scene: FoldSceneHandle | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const startScene = async (): Promise<void> => {
      let sceneFactory = createScene;
      if (sceneFactory === undefined) {
        const webgl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (webgl === null) {
          if (!cancelled) setWebglUnavailable(true);
          return;
        }
        sceneFactory = (await (loadScene ?? defaultLoadScene)()).createFoldScene;
      }

      if (cancelled) return;
      const nextScene = sceneFactory(canvas, {
        onContextLost: () => {
          if (!cancelled) setContextLost(true);
        },
        onContextRestored: () => {
          if (!cancelled) setContextLost(false);
        },
        // 拖轉即停自轉（fold-scene 已自行關 controls.autoRotate）——FoldView state 跟上，
        // checkbox 不再謊報開啟（final review F3）；使用者可用 checkbox 重新開啟。
        onUserInteract: () => {
          if (!cancelled) {
            autoRotateRef.current = false;
            setAutoRotate(false);
          }
        },
      });

      if (cancelled) {
        nextScene.dispose();
        return;
      }

      scene = nextScene;
      sceneRef.current = nextScene;
      const currentModel = modelRef.current;
      if (currentModel !== undefined) {
        nextScene.replaceModel(currentModel, { thickness: thicknessRef.current });
      }
      nextScene.updatePose(foldProgressRef.current);
      nextScene.setAutoRotate(autoRotateRef.current);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          const { contentRect } = entries[0] ?? {};
          if (!cancelled && contentRect !== undefined) {
            nextScene.resize(contentRect.width, contentRect.height);
          }
        });
        resizeObserver.observe(container);
      }
    };

    void startScene().catch((error: unknown) => {
      console.error(error);
      if (!cancelled) setLoadFailed(true);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (scene !== null) {
        if (sceneRef.current === scene) sceneRef.current = null;
        scene.dispose();
      }
    };
  }, [canCreateScene, createScene, loadScene]);

  if (loadFailed) {
    // 無文案的空狀態殼（M1 copy checkpoint 約束）——data-fold-error 供測試/e2e 斷言。
    return <div className="fold-empty" data-fold-error="true" />;
  }

  if (modelRuntime !== null && (builder === undefined || validationErrors.length > 0)) {
    return <FoldEmpty copy={t('fold.unsupported')} />;
  }

  if (webglUnavailable && createScene === undefined) {
    return <FoldEmpty copy={t('fold.webglUnavailable')} />;
  }

  return modelRuntime === null ? (
    <section className="fold-view" data-context-lost={String(contextLost)} ref={containerRef} />
  ) : (
    <section className="fold-view" data-context-lost={String(contextLost)} ref={containerRef}>
      <canvas className="fold-canvas" ref={canvasRef} />
      <div className="foldbar" role="group" aria-label={t('fold.controls.aria')}>
        <button type="button" className="btn label" onClick={togglePlayback}>
          {t(playing ? 'fold.pause' : 'fold.play')}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          aria-label={t('fold.progress.aria')}
          value={foldProgress}
          onChange={(event) => {
            stopPlayback();
            updateFoldProgress(Number(event.target.value));
          }}
        />
        <label className="compat mono">
          <input
            type="checkbox"
            className="tick"
            checked={autoRotate}
            onChange={(event) => {
              const enabled = event.target.checked;
              autoRotateRef.current = enabled;
              setAutoRotate(enabled);
              sceneRef.current?.setAutoRotate(enabled);
            }}
          />
          {t('fold.autorotate')}
        </label>
      </div>
    </section>
  );
}
