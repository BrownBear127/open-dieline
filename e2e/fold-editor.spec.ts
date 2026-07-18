import { expect, test } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

function isEditorChunk(url: string): boolean {
  return /\/assets\/EditorView-[^/]+\.js$/.test(new URL(url).pathname);
}

test('loads the editor chunk only after EDIT and keeps it cached after DONE', async ({ page }) => {
  const editorChunkRequests: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'script' && isEditorChunk(request.url())) {
      editorChunkRequests.push(request.url());
    }
    await route.continue();
  });

  await gotoReady(page);
  await page.waitForLoadState('networkidle');
  expect(editorChunkRequests, 'DESIGN first paint must not request the editor chunk').toEqual([]);

  await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: dict['fold.art.edit'].en, exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(editorChunkRequests, 'FOLD preview before EDIT must not request the editor chunk').toEqual([]);

  await page.getByRole('button', { name: dict['fold.art.edit'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toBeVisible();
  await expect.poll(() => editorChunkRequests.length).toBe(1);

  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toHaveCount(0);
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await page.getByRole('button', { name: dict['fold.art.edit'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toBeVisible();
  expect(editorChunkRequests, 'DONE then EDIT must reuse the loaded chunk').toHaveLength(1);
});
