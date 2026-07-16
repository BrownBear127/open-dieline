import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedParams } from '@/core/types';
import type { FoldModel } from '@/fold/types';
import { t } from '@/i18n/t';
import type { createFoldScene, FoldSceneHandle } from '@/ui/fold-scene';

const defaultLoadScene = () => import('./fold-scene');

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
  const [foldProgress] = useState(1);
  const [contextLost, setContextLost] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    void loadFoldModelRuntime().then((runtime) => {
      if (!cancelled) setModelRuntime(runtime);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (validationErrors.length > 0) console.error(validationErrors);
  }, [validationErrors]);

  useEffect(() => {
    if (canCreateScene && model !== undefined) sceneRef.current?.replaceModel(model);
  }, [canCreateScene, model]);

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
      });

      if (cancelled) {
        nextScene.dispose();
        return;
      }

      scene = nextScene;
      sceneRef.current = nextScene;
      const currentModel = modelRef.current;
      if (currentModel !== undefined) nextScene.replaceModel(currentModel);
      nextScene.updatePose(foldProgress);

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
      if (!cancelled) console.error(error);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (scene !== null) {
        if (sceneRef.current === scene) sceneRef.current = null;
        scene.dispose();
      }
    };
  }, [canCreateScene, createScene, foldProgress, loadScene]);

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
    </section>
  );
}
