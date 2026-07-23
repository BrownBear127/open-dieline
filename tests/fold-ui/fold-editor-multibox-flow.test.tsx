/**
 * ttsl／ttb 兩盒型各自跑一次「完整 editor 流程」——加入圖稿、undo/redo、
 * 套回 3D、PNG 下載檔名、模板下載檔名。本檔比照 `fold-editor-wiring.test.tsx`
 * 的 Harness／mock 慣例（EditorView 用可點擊
 * stub 替身——真實 EditorView 靠 canvas 2D context 互動，jsdom 沒有實作），
 * boxId／values 為可傳入參數，針對 ttsl／ttb 各跑一次代表性完整流程。
 *
 * 本檔的 pngName/svgName 是獨立寫死的期望字串（不重算 production 端的欄位過濾邏輯），
 * 用來驗證 `dimensionKeys()`（fold-template.ts/FoldView.tsx）在 ttb／ttsl 兩種盒型上
 * 各自算出的檔名字面正確（ttsl 跟 rte 一樣宣告 L/W/D，ttb 只宣告
 * edgeA/tubeLength）。
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import {
  FoldView,
  type ArtworkFileLoader,
  type EditorViewLoader,
} from '@/ui/FoldView';
import type { EditableArtworkAsset } from '@/ui/artwork-source';
import type { EditorSession } from '@/ui/editor/editor-session';
import { reduce, type EditorState } from '@/ui/editor/editor-state';
import type {
  CustomArtworkSource,
  FoldSceneHandle,
  createFoldScene,
} from '@/ui/fold-scene';

const composeArtworkMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/editor/editor-compose', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/ui/editor/editor-compose')>(),
  composeArtwork: composeArtworkMock,
}));

// 精簡版 EditorView stub，比照 fold-editor-wiring.test.tsx 既有慣例：真實 EditorView 靠
// canvas 2D context 做拖曳/繪製互動，jsdom 沒有實作，因此重互動流程一律換成可點擊按鈕的
// stub 替身。STUB UNDO/STUB REDO 呼叫 history.undo()/redo() 拿到快照就 dispatch——等價於
// 真實 EditorView 鍵盤 Cmd/Ctrl+Z（見 src/ui/editor/EditorView.tsx 同段 `history.undo()`/
// `history.redo()` 呼叫）的語意，只是觸發方式從鍵盤換成按鈕，行為（呼叫哪個 API、如何
// dispatch）逐字相同。
vi.mock('@/ui/editor/EditorView', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ state, dispatch, history, onAddImage, onDownload, onExit }: {
      state: EditorState;
      dispatch: (state: EditorState) => void;
      history: EditorSession['history'];
      onAddImage?: () => void;
      onDownload?: () => void;
      onExit: () => void;
    }) => createElement('div', { 'data-testid': 'editor-stub' },
      createElement('div', { 'data-testid': 'editor-state', role: 'presentation' }, JSON.stringify(state)),
      createElement('button', { type: 'button', onClick: onAddImage }, 'STUB IMAGE'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const next = reduce(state, {
            type: 'addText',
            frameSpan: 200,
            frameCenterX: 40,
            frameCenterY: 110,
            defaultText: `TEXT-${state.objects.length + 1}`,
          });
          dispatch(next);
          history.commit(next);
        },
      }, 'STUB TEXT'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const snapshot = history.undo();
          if (snapshot !== null) dispatch(snapshot);
        },
      }, 'STUB UNDO'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const snapshot = history.redo();
          if (snapshot !== null) dispatch(snapshot);
        },
      }, 'STUB REDO'),
      createElement('button', { type: 'button', onClick: onDownload }, 'STUB DOWNLOAD'),
      createElement('button', { type: 'button', onClick: onExit }, 'DONE'),
    ),
  };
});

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function editableAsset(width: number, height: number, revision = 1): EditableArtworkAsset {
  return { bitmap: bitmap(width, height), width, height, revision };
}

function createFakeScene() {
  const handles: FoldSceneHandle[] = [];
  const createScene = vi.fn<typeof createFoldScene>(() => {
    const handle: FoldSceneHandle = {
      updatePose: vi.fn(),
      replaceModel: vi.fn(),
      setAutoRotate: vi.fn(),
      applyRecipe: vi.fn(),
      applyArtwork: vi.fn(),
      installCustomSource: vi.fn(),
      removeCustomSource: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    handles.push(handle);
    return handle;
  });
  return { createScene, handles };
}

interface HarnessProps {
  boxId: string;
  values: ResolvedParams;
  createScene: typeof createFoldScene;
  loadArtwork?: ArtworkFileLoader;
  loadEditorView?: EditorViewLoader;
}

function Harness({ boxId, values, createScene, loadArtwork, loadEditorView }: HarnessProps) {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [customSource, setCustomSource] = useState<CustomArtworkSource | null>(null);
  const [editableArtwork, setEditableArtwork] = useState<EditableArtworkAsset | null>(null);
  return (
    <FoldView
      boxId={boxId}
      values={values}
      createScene={createScene}
      customSource={customSource}
      onCustomSourceChange={setCustomSource}
      editableArtwork={editableArtwork}
      onEditableArtworkChange={setEditableArtwork}
      onEditableArtworkConsumed={(consumed) => {
        setEditableArtwork((current) => current === consumed ? null : current);
      }}
      editorSession={session}
      onEditorSessionChange={setSession}
      loadArtwork={loadArtwork}
      loadEditorView={loadEditorView}
    />
  );
}

beforeEach(() => {
  setLang('en');
  composeArtworkMock.mockReset();
  composeArtworkMock.mockImplementation(() => document.createElement('canvas'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLang('en');
});

async function openEditor(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
  await act(async () => {
    await import('@/ui/editor/EditorView');
  });
  expect(screen.getByTestId('editor-stub')).toBeInTheDocument();
}

function editorObjectCount(): number {
  const state = JSON.parse(screen.getByTestId('editor-state').textContent!) as EditorState;
  return state.objects.length;
}

const TTSL_VALUES = resolveParams(tuckTopSnapLock, {});
const TTB_VALUES = resolveParams(triangularTube, {});

describe('FoldView — 兩盒型（ttsl／ttb）完整 editor 流程驗收', () => {
  it.each([
    {
      boxId: 'ttsl',
      values: TTSL_VALUES,
      pngName: `open-dieline-artwork-ttsl-${TTSL_VALUES.L}x${TTSL_VALUES.W}x${TTSL_VALUES.D}.png`,
      svgName: `open-dieline-template-ttsl-${TTSL_VALUES.L}x${TTSL_VALUES.W}x${TTSL_VALUES.D}.svg`,
    },
    {
      boxId: 'ttb',
      values: TTB_VALUES,
      pngName: `open-dieline-artwork-ttb-${TTB_VALUES.edgeA}x${TTB_VALUES.tubeLength}.png`,
      svgName: `open-dieline-template-ttb-${TTB_VALUES.edgeA}x${TTB_VALUES.tubeLength}.svg`,
    },
  ] as const)('$boxId：加圖 → undo/redo → 套回 3D → PNG／模板下載檔名全對', async ({
    boxId, values, pngName, svgName,
  }) => {
    const fake = createFakeScene();
    // 上傳流程的 CustomArtworkSource 引數在「session 已存在」分支裡只是過渡值——
    // handleUploadFile 收到 nextEditableArtwork 後改走 addEditableArtwork 合併進 session，
    // source.canvas 隨即被歸零丟棄（見 FoldView.tsx handleUploadFile），signature 字面
    // 不影響本測試斷言，給任意字串即可。
    const uploadedSource: CustomArtworkSource = {
      canvas: document.createElement('canvas'),
      signature: 'upload-transient',
    };
    const uploadedEditable = editableAsset(200, 100);
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      options.onCommit(uploadedSource, uploadedEditable);
      return { status: 'committed', warnings: [] };
    });

    const view = render(
      <Harness boxId={boxId} values={values} createScene={fake.createScene} loadArtwork={loadArtwork} />,
    );

    await waitFor(() => expect(fake.createScene).toHaveBeenCalledOnce());
    const editButton = await screen.findByRole('button', { name: t('fold.art.edit') });
    expect(editButton).not.toBeDisabled();

    // 加入圖稿：先開編輯器（此時尚無 session，enterEditor 建立空白 session），
    // 點「加入圖片」觸發隱藏 file input，再選檔——與既有 upload 測試同一組 API。
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'STUB IMAGE' }));
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
    });
    await act(async () => undefined);
    expect(loadArtwork).toHaveBeenCalledOnce();
    expect(editorObjectCount()).toBe(1);

    // 疊一個文字物件，讓 undo/redo 有實質差異可驗證。
    fireEvent.click(screen.getByRole('button', { name: 'STUB TEXT' }));
    expect(editorObjectCount()).toBe(2);

    // undo/redo：History 是否正確地把物件數往返還原（不只是「按鈕存在」）。
    fireEvent.click(screen.getByRole('button', { name: 'STUB UNDO' }));
    expect(editorObjectCount()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'STUB REDO' }));
    expect(editorObjectCount()).toBe(2);

    // 套回 3D：DONE 離開編輯器 → align + compose → activateCustomSource 把合成結果真的
    // 安裝進 3D 場景（installCustomSource／applyArtwork('custom')），不是只更新 React state。
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));
    expect(composeArtworkMock).toHaveBeenCalled();
    expect(fake.handles[0]!.installCustomSource).toHaveBeenCalled();
    expect(fake.handles[0]!.applyArtwork).toHaveBeenCalledWith('custom');

    // PNG 下載檔名：重進編輯器點下載（session 沿用既有物件，不重新播種）。
    await openEditor();
    expect(editorObjectCount()).toBe(2);
    const composed = document.createElement('canvas');
    const png = new Blob(['png'], { type: 'image/png' });
    composed.toBlob = vi.fn((callback: BlobCallback) => callback(png));
    composeArtworkMock.mockReturnValueOnce(composed);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:artwork');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload(
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
    });

    fireEvent.click(screen.getByRole('button', { name: 'STUB DOWNLOAD' }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(png));
    expect(downloadedName).toBe(pngName);

    // 模板下載檔名：離開編輯器回 preview，點模板下載鈕（走真實 fold-template.ts，非 mock）。
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));
    downloadedName = '';
    fireEvent.click(await screen.findByRole('button', { name: t('fold.art.template') }));

    await waitFor(() => expect(downloadedName).toBe(svgName));
  });
});
