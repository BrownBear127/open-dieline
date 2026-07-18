import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel } from '@/fold/types';
import { t } from '@/i18n/t';
import {
  clearInitialFoldProgress,
  P3_TEST_HOOKS_ENABLED,
  peekInitialFoldProgress,
} from '@/ui/fold-hooks';
import type { ArtworkLoadResult, EditableArtworkAsset } from '@/ui/artwork-source';
import {
  artworkLayoutSignature,
  deriveArtworkLayout,
} from '@/ui/artwork-layout';
import type { EditorViewProps } from '@/ui/editor/EditorView';
import { composeArtwork } from '@/ui/editor/editor-compose';
import { MAX_EDITOR_OBJECTS } from '@/ui/editor/editor-state';
import {
  addEditableArtwork,
  alignEditorSession,
  createEditorSession,
  updateEditorSessionState,
  type EditorSession,
} from '@/ui/editor/editor-session';
import type { FoldRecipeName } from '@/ui/fold-paper-colors';
import type {
  ArtworkMode,
  createFoldScene,
  CustomArtworkSource,
  FoldSceneHandle,
} from '@/ui/fold-scene';

const defaultLoadScene = () => import('./fold-scene');
const defaultLoadEditorView: EditorViewLoader = () => import('@/ui/editor/EditorView');
const FOLD_PLAY_DURATION_MS = 2400;
const DEFAULT_FOLD_PROGRESS = 1;
const EDITOR_COMPOSE_SIZE = 2048;
const EDITOR_DOWNLOAD_SIZE = 4096;
const EDITOR_SYNC_DELAY_MS = 300;
// __p3SetInitialFoldProgress 註冊已遷 fold-hooks.ts（main 側·lazy 化後須先於本 chunk 存在）。

function clampFoldProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

function buildArtworkFilename(boxId: string, values: ResolvedParams): string {
  const dim = (key: string): string => {
    const value = values[key];
    return value === undefined ? '?' : String(value);
  };
  return `open-dieline-artwork-${boxId}-${dim('L')}x${dim('W')}x${dim('D')}.png`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(link);
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
  editableArtwork?: EditableArtworkAsset | null;
  onEditableArtworkChange?: (asset: EditableArtworkAsset | null) => void;
  onEditableArtworkConsumed?: (asset: EditableArtworkAsset) => void;
  editorSession?: EditorSession | null;
  onEditorSessionChange?: (session: EditorSession) => void;
  loadArtwork?: ArtworkFileLoader;
  createScene?: typeof createFoldScene;
  loadScene?: () => Promise<{ createFoldScene: typeof createFoldScene }>;
  loadEditorView?: EditorViewLoader;
}

export type EditorViewLoader = () => Promise<{ default: ComponentType<EditorViewProps> }>;

export interface ArtworkFileLoadOptions {
  signature: string;
  signal?: AbortSignal;
  onCommit: (source: CustomArtworkSource, editableAsset?: EditableArtworkAsset) => void;
}

export type ArtworkFileLoader = (
  file: File,
  options: ArtworkFileLoadOptions,
) => Promise<ArtworkLoadResult>;

type UploadStatus = 'idle' | 'loading' | 'fold.art.invalidFile' | 'fold.art.invalidSvg';
type EditorStatusKey = 'editor.limit.objects' | 'editor.error.compose';
export type FoldViewMode = 'preview' | 'editor';

function uploadStatusForResult(result: ArtworkLoadResult): UploadStatus {
  if (result === 'committed' || result === 'cancelled') return 'idle';
  return result.code === 'external' || result.code === 'parse'
    ? 'fold.art.invalidSvg'
    : 'fold.art.invalidFile';
}

function FoldEmpty({ copy, loadFailed = false }: { copy: string; loadFailed?: boolean }) {
  return (
    <div className="fold-empty" data-fold-error={loadFailed ? 'true' : undefined}>
      <p className="mono">{copy}</p>
    </div>
  );
}

function EditorChunkLoading() {
  return <div className="fold-empty" data-editor-loading="true" aria-busy="true" />;
}

class EditorChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) return <FoldEmpty copy={t('fold.loadFailed')} loadFailed />;
    return this.props.children;
  }
}

function FoldArtworkStatus({
  uploadStatus,
  editorStatusKey,
  staleTemplate,
  staleEditor,
}: {
  uploadStatus: UploadStatus;
  editorStatusKey: EditorStatusKey | null;
  staleTemplate: boolean;
  staleEditor: boolean;
}) {
  if (uploadStatus === 'fold.art.invalidFile' || uploadStatus === 'fold.art.invalidSvg') {
    return <p className="fold-status mono" role="alert">{t(uploadStatus)}</p>;
  }
  if (editorStatusKey !== null) {
    return <p className="fold-status mono" role="status">{t(editorStatusKey)}</p>;
  }
  if (staleTemplate) {
    return <p className="fold-status mono" role="status">{t('fold.art.staleTemplate')}</p>;
  }
  if (staleEditor) {
    return <p className="fold-status mono" role="status">{t('editor.stale')}</p>;
  }
  return null;
}

export function FoldView({
  boxId,
  values,
  customSource = null,
  onCustomSourceChange,
  editableArtwork,
  onEditableArtworkChange,
  onEditableArtworkConsumed,
  editorSession,
  onEditorSessionChange,
  loadArtwork,
  createScene,
  loadScene,
  loadEditorView,
}: FoldViewProps) {
  const EditorView = useMemo(
    () => lazy(loadEditorView ?? defaultLoadEditorView),
    [loadEditorView],
  );
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
  const editorSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localEditorSession, setLocalEditorSession] = useState<EditorSession | null>(null);
  const [localEditableArtwork, setLocalEditableArtwork] = useState<EditableArtworkAsset | null>(null);
  const currentEditorSession = editorSession === undefined ? localEditorSession : editorSession;
  const currentEditableArtwork = editableArtwork === undefined
    ? localEditableArtwork
    : editableArtwork;
  const editorSessionRef = useRef<EditorSession | null>(currentEditorSession);
  const editableArtworkRef = useRef<EditableArtworkAsset | null>(currentEditableArtwork);
  const onCustomSourceChangeRef = useRef(onCustomSourceChange);
  const observedContentRevisionRef = useRef(currentEditorSession?.contentRevision ?? 0);
  editorSessionRef.current = currentEditorSession;
  editableArtworkRef.current = currentEditableArtwork;
  onCustomSourceChangeRef.current = onCustomSourceChange;
  // 自轉預設關閉（2026-07-17 E2E 驗收裁決）：進場靜止，由使用者主動開啟。
  const autoRotateRef = useRef(false);
  const [foldProgress, setFoldProgress] = useState(initialFoldProgress);
  const [playing, setPlaying] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [cardRecipe, setCardRecipe] = useState<FoldRecipeName>('kraft');
  const [artwork, setArtwork] = useState<ArtworkMode>(initialArtwork);
  const [sceneArtwork, setSceneArtwork] = useState<ArtworkMode>('none');
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [editorStatusKey, setEditorStatusKey] = useState<EditorStatusKey | null>(null);
  const [staleTemplate, setStaleTemplate] = useState(false);
  const [viewMode, setViewMode] = useState<FoldViewMode>('preview');
  const artworkEnabled = artwork === 'sample';
  const [contextLost, setContextLost] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  // dynamic chunk（model runtime 或 fold-scene）載入失敗：藏控制列與 canvas、render 文案空狀態。
  // 切走再進＝remount 重試。
  const [loadFailed, setLoadFailed] = useState(false);
  const [modelRuntime, setModelRuntime] = useState<FoldModelRuntime | null>(null);
  const builder = modelRuntime?.builders[boxId];
  const model = useMemo<FoldModel | undefined>(() => builder?.(values), [boxId, values, builder]);
  const artworkSignature = useMemo(
    () => model === undefined ? null : artworkLayoutSignature(model),
    [model],
  );
  const artworkLayout = useMemo(
    () => model === undefined ? null : deriveArtworkLayout(model),
    [model],
  );
  const validationErrors = useMemo(
    () => model === undefined ? [] : modelRuntime?.validate(model) ?? [],
    [model, modelRuntime],
  );
  const canCreateScene = model !== undefined && validationErrors.length === 0;
  const staleEditor = currentEditorSession !== null
    && artworkSignature !== null
    && currentEditorSession.alignedLayoutSignature !== artworkSignature;
  const artworkLayoutRef = useRef(artworkLayout);
  const artworkSignatureRef = useRef(artworkSignature);
  artworkLayoutRef.current = artworkLayout;
  artworkSignatureRef.current = artworkSignature;
  const modelRef = useRef(model);
  modelRef.current = model;
  const thickness = values.thickness as number;
  const thicknessRef = useRef(thickness);
  thicknessRef.current = thickness;

  const publishEditorSession = (nextSession: EditorSession): void => {
    editorSessionRef.current = nextSession;
    if (editorSession === undefined) setLocalEditorSession(nextSession);
    onEditorSessionChange?.(nextSession);
  };

  const replaceEditableArtwork = (nextAsset: EditableArtworkAsset | null): void => {
    const previousAsset = editableArtworkRef.current;
    editableArtworkRef.current = nextAsset;
    if (editableArtwork === undefined) {
      if (previousAsset !== null && previousAsset !== nextAsset) previousAsset.bitmap.close();
      setLocalEditableArtwork(nextAsset);
    }
    onEditableArtworkChange?.(nextAsset);
  };

  const consumeEditableArtwork = (asset: EditableArtworkAsset): void => {
    if (editableArtworkRef.current !== asset) return;
    editableArtworkRef.current = null;
    if (editableArtwork === undefined) setLocalEditableArtwork(null);
    onEditableArtworkConsumed?.(asset);
  };

  const activateCustomSource = (source: CustomArtworkSource): void => {
    customSourceRef.current = source;
    onCustomSourceChangeRef.current?.(source);
    sceneRef.current?.installCustomSource(source);
    artworkRef.current = 'custom';
    setArtwork('custom');
    sceneRef.current?.applyArtwork('custom');
    setSceneArtwork('custom');
    setStaleTemplate(false);
  };

  const composeEditorSession = (session: EditorSession): boolean => {
    const layout = artworkLayoutRef.current;
    const signature = artworkSignatureRef.current;
    if (layout === null || signature === null) return false;
    try {
      const canvas = composeArtwork(
        session.state,
        layout,
        EDITOR_COMPOSE_SIZE,
        { guides: false },
        session.assetRegistry,
      );
      activateCustomSource({ canvas, signature });
      setEditorStatusKey((current) => current === 'editor.error.compose' ? null : current);
      return true;
    } catch {
      setEditorStatusKey('editor.error.compose');
      return false;
    }
  };

  const cancelEditorSync = (): void => {
    if (editorSyncTimerRef.current === null) return;
    clearTimeout(editorSyncTimerRef.current);
    editorSyncTimerRef.current = null;
  };

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
    const scene = sceneRef.current;
    if (scene !== null) {
      scene.applyArtwork(mode);
      setSceneArtwork(mode);
    }
    if (mode !== 'custom' && customSourceRef.current !== null) {
      scene?.removeCustomSource();
      customSourceRef.current = null;
      onCustomSourceChangeRef.current?.(null);
    }
    if (mode !== 'custom' && editableArtworkRef.current !== null) {
      replaceEditableArtwork(null);
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
    if (artwork === 'custom' && editorSessionRef.current === null) {
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
    const currentSession = editorSessionRef.current;
    if (currentSession !== null && currentSession.state.objects.length >= MAX_EDITOR_OBJECTS) {
      setUploadStatus('idle');
      setEditorStatusKey('editor.limit.objects');
      return;
    }
    setEditorStatusKey((current) => current === 'editor.limit.objects' ? null : current);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadStatus('loading');

    const startUpload = async (): Promise<void> => {
      const loader = loadArtwork ?? (await import('./artwork-source')).loadArtworkFile;
      if (controller.signal.aborted) return;
      const result = await loader(file, {
        signature: artworkSignature ?? '',
        signal: controller.signal,
        onCommit: (source, nextEditableArtwork) => {
          const session = editorSessionRef.current;
          const layout = artworkLayoutRef.current;
          if (nextEditableArtwork !== undefined) {
            replaceEditableArtwork(nextEditableArtwork);
          }
          if (session !== null && layout !== null && nextEditableArtwork !== undefined) {
            try {
              const nextSession = addEditableArtwork(session, nextEditableArtwork, layout);
              consumeEditableArtwork(nextEditableArtwork);
              source.canvas.width = source.canvas.height = 0;
              if (nextSession === session) {
                setEditorStatusKey('editor.limit.objects');
                return;
              }
              publishEditorSession(nextSession);
              if (composeEditorSession(nextSession)) {
                observedContentRevisionRef.current = nextSession.contentRevision;
              }
            } catch (error) {
              source.canvas.width = source.canvas.height = 0;
              setUploadStatus('fold.art.invalidFile');
              console.error(error);
            }
            return;
          }
          activateCustomSource(source);
        },
      });
      if (uploadAbortRef.current !== controller) return;
      uploadAbortRef.current = null;
      setUploadStatus(uploadStatusForResult(result));
    };

    void startUpload().catch((error: unknown) => {
      if (uploadAbortRef.current !== controller) return;
      uploadAbortRef.current = null;
      setUploadStatus('fold.art.invalidFile');
      console.error(error);
    });
  };

  const enterEditor = (): void => {
    const layout = artworkLayoutRef.current;
    const signature = artworkSignatureRef.current;
    if (layout === null || signature === null || boxId !== 'rte') return;

    let session = editorSessionRef.current;
    if (session === null) {
      const seed = artworkRef.current === 'custom' ? editableArtworkRef.current : null;
      session = createEditorSession(signature, layout, seed ?? undefined);
      if (seed !== null) consumeEditableArtwork(seed);
      publishEditorSession(session);
    }
    setViewMode('editor');
  };

  const dispatchEditorState = (nextState: EditorSession['state']): void => {
    const session = editorSessionRef.current;
    if (session === null) return;
    publishEditorSession(updateEditorSessionState(session, nextState));
    if (nextState.objects.length < MAX_EDITOR_OBJECTS) {
      setEditorStatusKey((current) => current === 'editor.limit.objects' ? null : current);
    }
  };

  const downloadEditorArtwork = (): void => {
    const session = editorSessionRef.current;
    const layout = artworkLayoutRef.current;
    if (session === null || layout === null) return;
    try {
      const canvas = composeArtwork(
        session.state,
        layout,
        EDITOR_DOWNLOAD_SIZE,
        { mode: 'download' },
        session.assetRegistry,
      );
      canvas.toBlob((blob) => {
        if (blob === null) {
          setEditorStatusKey('editor.error.compose');
          return;
        }
        try {
          downloadBlob(blob, buildArtworkFilename(boxId, values));
          setEditorStatusKey((current) => current === 'editor.error.compose' ? null : current);
        } catch {
          setEditorStatusKey('editor.error.compose');
        }
      }, 'image/png');
    } catch {
      setEditorStatusKey('editor.error.compose');
    }
  };

  const exitEditor = (): void => {
    cancelEditorSync();
    const session = editorSessionRef.current;
    const signature = artworkSignatureRef.current;
    if (session !== null && signature !== null) {
      const aligned = alignEditorSession(session, signature);
      publishEditorSession(aligned);
      if (composeEditorSession(aligned)) {
        observedContentRevisionRef.current = aligned.contentRevision;
      }
    }
    setViewMode('preview');
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

  useEffect(() => () => cancelEditorSync(), []);

  useEffect(() => {
    const session = currentEditorSession;
    if (session === null) {
      observedContentRevisionRef.current = 0;
      cancelEditorSync();
      return;
    }
    if (session.contentRevision === observedContentRevisionRef.current) return;

    observedContentRevisionRef.current = session.contentRevision;
    cancelEditorSync();
    const scheduledRevision = session.contentRevision;
    editorSyncTimerRef.current = setTimeout(() => {
      editorSyncTimerRef.current = null;
      const latestSession = editorSessionRef.current;
      if (latestSession?.contentRevision !== scheduledRevision) return;
      composeEditorSession(latestSession);
    }, EDITOR_SYNC_DELAY_MS);
  }, [currentEditorSession?.contentRevision]);

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
      currentEditorSession === null
      && artwork === 'custom'
      && artworkSignature !== null
      && customSourceRef.current !== null
      && customSourceRef.current.signature !== artworkSignature
    ) {
      setStaleTemplate(true);
    }
  }, [artwork, artworkSignature, currentEditorSession]);

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
      setSceneArtwork(artworkRef.current);

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

  if (modelRuntime !== null && builder === undefined) {
    return (
      <section className="fold-view" ref={containerRef}>
        <FoldEmpty copy={t('fold.unsupported')} />
        <div className="fold-tools">
          <div className="fold-tool-group" role="group" aria-label={t('fold.art.label')}>
            <button type="button" className="btn label" disabled>
              {t('fold.art.edit')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (modelRuntime !== null && validationErrors.length > 0) {
    return <FoldEmpty copy={t('fold.unsupported')} />;
  }

  if (webglUnavailable && createScene === undefined) {
    return <FoldEmpty copy={t('fold.webglUnavailable')} />;
  }

  const artworkStatus = (
    <FoldArtworkStatus
      uploadStatus={uploadStatus}
      editorStatusKey={editorStatusKey}
      staleTemplate={staleTemplate}
      staleEditor={staleEditor}
    />
  );

  return modelRuntime === null ? (
    <section
      className="fold-view"
      data-artwork-ready={sceneArtwork}
      data-context-lost={String(contextLost)}
      ref={containerRef}
    >
      {viewMode === 'preview' && artworkStatus}
    </section>
  ) : (
    <section
      className="fold-view"
      data-artwork-ready={sceneArtwork}
      data-context-lost={String(contextLost)}
      ref={containerRef}
    >
      <canvas className="fold-canvas" ref={canvasRef} hidden={viewMode === 'editor'} />
      {viewMode === 'preview' && artworkStatus}
      <div className="fold-tools" hidden={viewMode === 'editor'}>
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
          <button
            type="button"
            className="btn label"
            disabled={boxId !== 'rte'}
            onClick={enterEditor}
          >
            {t('fold.art.edit')}
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
      <div
        className="foldbar"
        role="group"
        aria-label={t('fold.controls.aria')}
        hidden={viewMode === 'editor'}
      >
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
      {viewMode === 'editor' && currentEditorSession !== null && artworkLayout !== null && (
        <>
          {staleEditor && editorStatusKey === null && (
            <p className="fold-status mono" role="status">{t('editor.stale')}</p>
          )}
          <EditorChunkBoundary>
            <Suspense fallback={<EditorChunkLoading />}>
              <EditorView
                state={currentEditorSession.state}
                dispatch={dispatchEditorState}
                history={currentEditorSession.history}
                layout={artworkLayout}
                registry={currentEditorSession.assetRegistry}
                viewCssPx={512}
                dpr={window.devicePixelRatio || 1}
                statusKey={editorStatusKey ?? undefined}
                onAddImage={() => fileInputRef.current?.click()}
                onDownload={downloadEditorArtwork}
                onExit={exitEditor}
              />
            </Suspense>
          </EditorChunkBoundary>
        </>
      )}
    </section>
  );
}
