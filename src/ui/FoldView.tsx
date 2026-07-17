import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel } from '@/fold/types';
import { t } from '@/i18n/t';
import type {
  ArtworkMode,
  createFoldScene,
  FoldRecipeName,
  FoldSceneHandle,
} from '@/ui/fold-scene';

const defaultLoadScene = () => import('./fold-scene');
const FOLD_PLAY_DURATION_MS = 2400;
const DEFAULT_FOLD_PROGRESS = 1;
const P3_TEST_HOOKS_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'e2e';
let nextInitialFoldProgress: number | undefined;

function clampFoldProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

if (P3_TEST_HOOKS_ENABLED && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__p3SetInitialFoldProgress = (progress: number) => {
    nextInitialFoldProgress = Number.isFinite(progress) ? clampFoldProgress(progress) : 0;
  };
}

const FOLD_CARD_RECIPES = [
  { name: 'white', labelKey: 'fold.card.white' },
  { name: 'kraft', labelKey: 'fold.card.kraft' },
  { name: 'black', labelKey: 'fold.card.black' },
] as const satisfies ReadonlyArray<{ name: FoldRecipeName; labelKey: string }>;

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

function FoldEmpty({ copy, loadFailed = false }: { copy: string; loadFailed?: boolean }) {
  return (
    <div className="fold-empty" data-fold-error={loadFailed ? 'true' : undefined}>
      <p className="mono">{copy}</p>
    </div>
  );
}

export function FoldView({ boxId, values, createScene, loadScene }: FoldViewProps) {
  const initialFoldProgress = P3_TEST_HOOKS_ENABLED
    ? nextInitialFoldProgress ?? DEFAULT_FOLD_PROGRESS
    : DEFAULT_FOLD_PROGRESS;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<FoldSceneHandle | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playbackStartedAtRef = useRef<number | null>(null);
  const playbackOriginRef = useRef(DEFAULT_FOLD_PROGRESS);
  const foldProgressRef = useRef(initialFoldProgress);
  const cardRecipeRef = useRef<FoldRecipeName>('kraft');
  const artworkRef = useRef<ArtworkMode>('none');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 自轉預設關閉（2026-07-17 E2E 驗收裁決）：進場靜止，由使用者主動開啟。
  const autoRotateRef = useRef(false);
  const [foldProgress, setFoldProgress] = useState(initialFoldProgress);
  const [playing, setPlaying] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [cardRecipe, setCardRecipe] = useState<FoldRecipeName>('kraft');
  const [artwork, setArtwork] = useState<ArtworkMode>('none');
  const artworkEnabled = artwork === 'sample';
  const [contextLost, setContextLost] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  // dynamic chunk（model runtime 或 fold-scene）載入失敗：藏控制列與 canvas、render 文案空狀態。
  // 切走再進＝remount 重試。
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
    const progress = clampFoldProgress(nextProgress);
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

  const selectCardRecipe = (name: FoldRecipeName): void => {
    cardRecipeRef.current = name;
    setCardRecipe(name);
    sceneRef.current?.applyRecipe(name);
  };

  const selectArtwork = (mode: ArtworkMode): void => {
    artworkRef.current = mode;
    setArtwork(mode);
    sceneRef.current?.applyArtwork(mode);
  };

  // P3 M3 T0 skeleton——重邏輯（builder/decode）恆走 lazy import（J1 C7b：main 只收接線）。
  const handleTemplateDownload = (): void => {
    void import('./fold-template').then(({ downloadTemplate }) => downloadTemplate());
  };

  const handleUploadClick = (): void => {
    if (artwork === 'custom') {
      selectArtwork('none');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleUploadFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    void import('./artwork-source').then(({ loadArtworkFile }) => loadArtworkFile(file));
  };

  const toggleAutoRotate = (): void => {
    const enabled = !autoRotateRef.current;
    autoRotateRef.current = enabled;
    setAutoRotate(enabled);
    sceneRef.current?.setAutoRotate(enabled);
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
        // 按鈕不再謊報開啟（final review F3）；使用者可用按鈕重新開啟。
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

      if (P3_TEST_HOOKS_ENABLED) nextInitialFoldProgress = undefined;
      scene = nextScene;
      sceneRef.current = nextScene;
      const currentModel = modelRef.current;
      if (currentModel !== undefined) {
        nextScene.replaceModel(currentModel, { thickness: thicknessRef.current });
      }
      nextScene.updatePose(foldProgressRef.current);
      nextScene.setAutoRotate(autoRotateRef.current);
      if (cardRecipeRef.current !== 'kraft') {
        nextScene.applyRecipe(cardRecipeRef.current);
      }
      if (artworkRef.current !== 'none') {
        nextScene.applyArtwork(artworkRef.current);
      }

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
    return <FoldEmpty copy={t('fold.loadFailed')} loadFailed />;
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
      <div className="fold-tools">
        <div className="fold-tool-group" role="group" aria-label={t('fold.card.label')}>
          {FOLD_CARD_RECIPES.map(({ name, labelKey }) => (
            <button
              key={name}
              type="button"
              className={`btn tog label${cardRecipe === name ? ' on' : ''}`}
              aria-pressed={cardRecipe === name}
              onClick={() => selectCardRecipe(name)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="fold-tool-group" role="group" aria-label={t('fold.art.label')}>
          <button
            type="button"
            className={`btn tog label${artworkEnabled ? ' on' : ''}`}
            aria-pressed={artworkEnabled}
            onClick={() => selectArtwork(artworkEnabled ? 'none' : 'sample')}
          >
            {t('fold.art.sample')}
          </button>
          <button type="button" className="btn label" onClick={handleTemplateDownload}>
            {t('fold.art.template')}
          </button>
          <button
            type="button"
            className={`btn tog label${artwork === 'custom' ? ' on' : ''}`}
            aria-pressed={artwork === 'custom'}
            onClick={handleUploadClick}
          >
            {t('fold.art.upload')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            hidden
            onChange={handleUploadFile}
          />
        </div>
        <button
          type="button"
          className={`btn tog label${autoRotate ? ' on' : ''}`}
          aria-pressed={autoRotate}
          onClick={toggleAutoRotate}
        >
          {t('fold.autorotate')}
        </button>
      </div>
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
      </div>
    </section>
  );
}
