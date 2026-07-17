import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel } from '@/fold/types';
import { t } from '@/i18n/t';
import {
  clearInitialFoldProgress,
  P3_TEST_HOOKS_ENABLED,
  peekInitialFoldProgress,
} from '@/ui/fold-hooks';
import type { ArtworkLoadResult } from '@/ui/artwork-source';
import type {
  ArtworkMode,
  createFoldScene,
  CustomArtworkSource,
  FoldRecipeName,
  FoldSceneHandle,
} from '@/ui/fold-scene';

const defaultLoadScene = () => import('./fold-scene');
const FOLD_PLAY_DURATION_MS = 2400;
const DEFAULT_FOLD_PROGRESS = 1;
// __p3SetInitialFoldProgress 註冊已遷 fold-hooks.ts（main 側·lazy 化後須先於本 chunk 存在）。

function clampFoldProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
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
  customSource?: CustomArtworkSource | null;
  onCustomSourceChange?: (source: CustomArtworkSource | null) => void;
  loadArtwork?: ArtworkFileLoader;
  createScene?: typeof createFoldScene;
  loadScene?: () => Promise<{ createFoldScene: typeof createFoldScene }>;
}

export interface ArtworkFileLoadOptions {
  signature: string;
  signal?: AbortSignal;
  onCommit: (source: CustomArtworkSource) => void;
}

export type ArtworkFileLoader = (
  file: File,
  options: ArtworkFileLoadOptions,
) => Promise<ArtworkLoadResult>;

type UploadStatus = 'idle' | 'loading' | 'error';

function FoldEmpty({ copy, loadFailed = false }: { copy: string; loadFailed?: boolean }) {
  return (
    <div className="fold-empty" data-fold-error={loadFailed ? 'true' : undefined}>
      <p className="mono">{copy}</p>
    </div>
  );
}

function FoldArtworkStatus({
  uploadStatus,
  staleTemplate,
}: {
  uploadStatus: UploadStatus;
  staleTemplate: boolean;
}) {
  if (uploadStatus === 'error') {
    return <p className="fold-status mono" role="alert">{t('fold.art.invalidFile')}</p>;
  }
  if (staleTemplate) {
    return <p className="fold-status mono" role="status">{t('fold.art.staleTemplate')}</p>;
  }
  return null;
}

export function FoldView({
  boxId,
  values,
  customSource = null,
  onCustomSourceChange,
  loadArtwork,
  createScene,
  loadScene,
}: FoldViewProps) {
  const initialFoldProgress = P3_TEST_HOOKS_ENABLED
    ? peekInitialFoldProgress() ?? DEFAULT_FOLD_PROGRESS
    : DEFAULT_FOLD_PROGRESS;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<FoldSceneHandle | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playbackStartedAtRef = useRef<number | null>(null);
  const playbackOriginRef = useRef(DEFAULT_FOLD_PROGRESS);
  const foldProgressRef = useRef(initialFoldProgress);
  const cardRecipeRef = useRef<FoldRecipeName>('kraft');
  const initialArtwork: ArtworkMode = customSource === null ? 'none' : 'custom';
  const artworkRef = useRef<ArtworkMode>(initialArtwork);
  const customSourceRef = useRef<CustomArtworkSource | null>(customSource);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 自轉預設關閉（2026-07-17 E2E 驗收裁決）：進場靜止，由使用者主動開啟。
  const autoRotateRef = useRef(false);
  const [foldProgress, setFoldProgress] = useState(initialFoldProgress);
  const [playing, setPlaying] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [cardRecipe, setCardRecipe] = useState<FoldRecipeName>('kraft');
  const [artwork, setArtwork] = useState<ArtworkMode>(initialArtwork);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [staleTemplate, setStaleTemplate] = useState(false);
  const artworkEnabled = artwork === 'sample';
  const [contextLost, setContextLost] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  // dynamic chunk（model runtime 或 fold-scene）載入失敗：藏控制列與 canvas、render 文案空狀態。
  // 切走再進＝remount 重試。
  const [loadFailed, setLoadFailed] = useState(false);
  const [modelRuntime, setModelRuntime] = useState<FoldModelRuntime | null>(null);
  const builder = modelRuntime?.builders[boxId];
  const model = useMemo<FoldModel | undefined>(() => builder?.(values), [boxId, values, builder]);
  const artworkSignature = useMemo(() => JSON.stringify([boxId, values]), [boxId, values]);
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

  const cancelPendingUpload = (): void => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
  };

  const selectArtwork = (mode: ArtworkMode): void => {
    cancelPendingUpload();
    setUploadStatus('idle');
    setStaleTemplate(false);
    artworkRef.current = mode;
    setArtwork(mode);
    sceneRef.current?.applyArtwork(mode);
    if (mode !== 'custom' && customSourceRef.current !== null) {
      sceneRef.current?.removeCustomSource();
      customSourceRef.current = null;
      onCustomSourceChange?.(null);
    }
  };

  // P3 M3 T1——重邏輯（ArtworkLayout 抽取／SVG builder）留在 lazy chunk（J1 C7b：main
  // 只收接線）。model 已在本元件算好（TEMPLATE 鈕只在 canCreateScene 為真時渲染，此時
  // model 必已定義），連同 boxId/values 一併傳給 builder；lang 由 downloadTemplate 內部
  // 讀 getLang()，不需在此額外傳遞。
  const handleTemplateDownload = (): void => {
    if (model === undefined) return;
    void import('./fold-template').then(({ downloadTemplate }) => downloadTemplate({ model, boxId, values }));
  };

  const handleUploadClick = (): void => {
    if (artwork === 'custom') {
      selectArtwork('none');
      return;
    }
    setUploadStatus('idle');
    fileInputRef.current?.click();
  };

  const handleUploadFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    cancelPendingUpload();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadStatus('loading');

    const startUpload = async (): Promise<void> => {
      const loader = loadArtwork ?? (await import('./artwork-source')).loadArtworkFile;
      if (controller.signal.aborted) return;
      const result = await loader(file, {
        signature: artworkSignature,
        signal: controller.signal,
        onCommit: (source) => {
          customSourceRef.current = source;
          onCustomSourceChange?.(source);
          sceneRef.current?.installCustomSource(source);
          selectArtwork('custom');
        },
      });
      if (uploadAbortRef.current !== controller) return;
      uploadAbortRef.current = null;
      setUploadStatus(result === 'committed' || result === 'cancelled' ? 'idle' : 'error');
    };

    void startUpload().catch((error: unknown) => {
      if (uploadAbortRef.current !== controller) return;
      uploadAbortRef.current = null;
      setUploadStatus('error');
      console.error(error);
    });
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

  useEffect(() => () => cancelPendingUpload(), []);

  useEffect(() => {
    if (!P3_TEST_HOOKS_ENABLED) return undefined;
    const readArtworkPixel = (u: number, v: number): number[] | null => {
      const canvas = customSourceRef.current?.canvas;
      if (canvas === undefined || !Number.isFinite(u) || !Number.isFinite(v)) return null;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) return null;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(u * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((1 - v) * canvas.height)));
      return [...context.getImageData(x, y, 1, 1).data];
    };
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__p3ReadArtworkPixel = readArtworkPixel;
    return () => {
      if (hooks.__p3ReadArtworkPixel === readArtworkPixel) delete hooks.__p3ReadArtworkPixel;
    };
  }, []);

  useEffect(() => {
    if (validationErrors.length > 0) console.error(validationErrors);
  }, [validationErrors]);

  useEffect(() => {
    if (
      artwork === 'custom'
      && customSourceRef.current !== null
      && customSourceRef.current.signature !== artworkSignature
    ) {
      setStaleTemplate(true);
    }
  }, [artwork, artworkSignature]);

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

      if (P3_TEST_HOOKS_ENABLED) clearInitialFoldProgress();
      scene = nextScene;
      sceneRef.current = nextScene;
      const currentModel = modelRef.current;
      if (currentModel !== undefined) {
        nextScene.replaceModel(currentModel, { thickness: thicknessRef.current });
      }
      if (customSourceRef.current !== null) {
        nextScene.installCustomSource(customSourceRef.current);
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

  const artworkStatus = (
    <FoldArtworkStatus uploadStatus={uploadStatus} staleTemplate={staleTemplate} />
  );

  return modelRuntime === null ? (
    <section
      className="fold-view"
      data-artwork-ready={artwork}
      data-context-lost={String(contextLost)}
      ref={containerRef}
    >
      {artworkStatus}
    </section>
  ) : (
    <section
      className="fold-view"
      data-artwork-ready={artwork}
      data-context-lost={String(contextLost)}
      ref={containerRef}
    >
      <canvas className="fold-canvas" ref={canvasRef} />
      {artworkStatus}
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
