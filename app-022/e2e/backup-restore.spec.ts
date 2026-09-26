import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));

async function gotoHome(page: Page) {
  await page.goto('/');
}

/** 新建一份字帖并回到首页 */
async function createOne(page: Page, chars: string): Promise<string> {
  await gotoHome(page);
  await page.fill('[data-testid="input-chars"]', chars);
  await page.click('[data-testid="create"]');
  await expect(page).toHaveURL(/\/worksheet\/[^/]+$/);
  const id = page.url().split('/').pop()!;
  await page.goto('/');
  return id;
}

async function listTitles(page: Page): Promise<string[]> {
  return page.locator('.recent-item strong').allInnerTexts();
}

type Backup = {
  app: string;
  version: number;
  exportedAt: string;
  count: number;
  worksheets: Record<string, unknown>[];
};

test.describe('字帖备份与恢复', () => {
  test('导出选中一份：文件含版本号、导出时间、份数与字帖内容', async ({ page }) => {
    await createOne(page, '春天');
    await createOne(page, '花朵');

    // 勾选「春天」那一份并导出选中（列表按最新排序，按内容定位行）
    const row = page.locator('.recent-item', { hasText: '春天字帖' });
    await row.locator('input[type="checkbox"]').check();
    const dl = page.waitForEvent('download');
    await page.click('[data-testid="export-selected"]');
    const download = await dl;
    const file = path.join(TMP, 'one.json');
    await download.saveAs(file);

    const backup: Backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(backup.app).toBe('tianzige-backup');
    expect(backup.version).toBe(1);
    expect(typeof backup.exportedAt).toBe('string');
    expect(backup.count).toBe(1);
    expect(backup.worksheets).toHaveLength(1);
    const ws = backup.worksheets[0] as { title: string; chars: string[]; layout: { grid: string } };
    expect(ws.title).toContain('春');
    expect(ws.chars).toEqual(['春', '天']);
    expect(ws.layout.grid).toBe('tian');
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  });

  test('导出全部包含所有字帖', async ({ page }) => {
    await createOne(page, '木');
    await createOne(page, '水');
    const dl = page.waitForEvent('download');
    await page.click('[data-testid="export-all"]');
    const download = await dl;
    const file = path.join(TMP, 'all.json');
    await download.saveAs(file);
    const backup: Backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(backup.count).toBe(2);
    // 导出全部后列表应全部勾选
    await expect(page.locator('[data-testid="check-all"]')).toBeChecked();
  });

  test('清数据后从备份恢复：新增计数、列表重新出现', async ({ page, context }) => {
    const id = await createOne(page, '山水');
    const dl = page.waitForEvent('download');
    await page.click('[data-testid="export-all"]');
    const file = path.join(TMP, `restore-${id}.json`);
    await (await dl).saveAs(file);

    // 换台电脑：清空浏览器存储
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.recent-item')).toHaveCount(0);

    await page.locator('[data-testid="import-backup-empty"]').setInputFiles(file);
    await expect(page.locator('[data-testid="import-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 1 份');
    // 没有冲突项，也没有问题条目
    await expect(page.locator('[data-testid="import-item"]')).toHaveCount(1);
    await page.click('[data-testid="import-restore"]');
    await expect(page.locator('[data-testid="result-added"]')).toHaveText('1');
    await expect(page.locator('[data-testid="result-overwritten"]')).toHaveText('0');
    await expect(page.locator('[data-testid="result-skipped"]')).toHaveText('0');
    await page.click('[data-testid="import-done"]');
    await expect(page.locator('.recent-item')).toHaveCount(1);
    expect(await listTitles(page)).toEqual(['山水字帖']);
  });

  test('同一份字帖已存在：覆盖 / 另存为新的一份 / 跳过', async ({ page }) => {
    const id = await createOne(page, '风雨');

    // 先导出原始备份（标题「风雨字帖」），再把本机标题改掉，制造版本差异
    const dl0 = page.waitForEvent('download');
    await page.click('[data-testid="export-all"]');
    const file = path.join(TMP, `conflict-${id}.json`);
    await (await dl0).saveAs(file);

    await page.goto(`/worksheet/${id}`);
    await page.fill('[data-testid="title-input"]', '本机改过的标题');
    await page.waitForTimeout(400); // 自动保存防抖
    await page.goto('/');
    // 导航完成后编辑器的卸载前落盘可能略晚于首页首帧，等列表更新
    await expect(page.locator('.recent-item strong').first()).toHaveText('本机改过的标题');

    // 覆盖：本机标题被备份里的「风雨字帖」顶掉
    await page.locator('[data-testid="import-backup"]').setInputFiles(file);
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('本机已有 1 份');
    await page.locator(`[data-testid="conflict-${id}-overwrite"]`).check();
    await page.click('[data-testid="import-restore"]');
    await expect(page.locator('[data-testid="result-overwritten"]')).toHaveText('1');
    await page.click('[data-testid="import-done"]');
    expect(await listTitles(page)).toEqual(['风雨字帖']);

    // 另存为新的一份
    await page.locator('[data-testid="import-backup"]').setInputFiles(file);
    await page.locator(`[data-testid="conflict-${id}-copy"]`).check();
    await page.click('[data-testid="import-restore"]');
    await expect(page.locator('[data-testid="result-added"]')).toHaveText('1');
    await page.click('[data-testid="import-done"]');
    expect((await listTitles(page)).sort()).toEqual(['风雨字帖', '风雨字帖（副本）']);

    // 跳过
    await page.locator('[data-testid="import-backup"]').setInputFiles(file);
    await page.locator(`[data-testid="conflict-${id}-skip"]`).check();
    await page.click('[data-testid="import-restore"]');
    await expect(page.locator('[data-testid="result-skipped"]')).toHaveText('1');
    await page.click('[data-testid="import-done"]');
    expect((await listTitles(page)).sort()).toEqual(['风雨字帖', '风雨字帖（副本）']);
  });

  test('版本号对不上：列出哪个文件坏在哪，一条都不恢复', async ({ page }) => {
    await createOne(page, '天地');
    const backup: Backup = {
      app: 'tianzige-backup',
      version: 99,
      exportedAt: new Date().toISOString(),
      count: 1,
      worksheets: [],
    };
    const file = path.join(TMP, 'bad-version.json');
    fs.writeFileSync(file, JSON.stringify(backup));

    await page.locator('[data-testid="import-backup"]').setInputFiles(file);
    await expect(page.locator('[data-testid="file-error"]')).toContainText('bad-version.json');
    await expect(page.locator('[data-testid="file-error"]')).toContainText('v99');
    await expect(page.locator('[data-testid="import-item"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-restore"]')).toHaveCount(0);
    await page.click('[data-testid="import-cancel"]');
    await expect(page.locator('.recent-item')).toHaveCount(1); // 原有字帖不受影响
  });

  test('内容缺字段：逐条列出第几份坏在哪，只恢复没坏的', async ({ page }) => {
    const good = {
      id: 'good-id',
      title: '好字帖',
      chars: ['好'],
      layout: {
        grid: 'tian',
        perLine: 10,
        lines: 10,
        cellMm: 20,
        lineGapMm: 2,
        mix: { model: 1, strokeSteps: 3, trace: 2, blank: 4 },
        show: { pinyin: true, radical: true, strokeCount: true, structure: true },
        traceColor: '#cccccc',
      },
      pages: 1,
      updatedAt: Date.now(),
    };
    const badLayout = { ...good, id: 'bad-layout', title: '版式坏', layout: { grid: 'xxx' } };
    const backup: Backup = {
      app: 'tianzige-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: 2,
      worksheets: [good, badLayout],
    };
    const file = path.join(TMP, 'partial.json');
    fs.writeFileSync(file, JSON.stringify(backup));

    await gotoHome(page);
    await page.locator('[data-testid="import-backup-empty"]').setInputFiles(file);
    // 第 2 份坏掉，错误里点名文件、序号与标题
    const entryErr = page.locator('[data-testid="entry-error"]');
    await expect(entryErr).toContainText('partial.json');
    await expect(entryErr).toContainText('第 2 份');
    await expect(entryErr).toContainText('版式坏');
    await expect(entryErr).toContainText('layout');
    // 好的一份可正常恢复
    await expect(page.locator('[data-testid="import-item"]')).toHaveCount(1);
    await page.click('[data-testid="import-restore"]');
    await expect(page.locator('[data-testid="result-added"]')).toHaveText('1');
    await page.click('[data-testid="import-done"]');
    expect(await listTitles(page)).toEqual(['好字帖']);
  });
});
