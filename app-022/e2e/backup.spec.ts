import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function createWorksheet(page: Page, chars: string): Promise<string> {
  await page.goto('/');
  await page.fill('[data-testid="input-chars"]', chars);
  await page.click('[data-testid="create"]');
  await expect(page).toHaveURL(/\/worksheet\/[^/]+$/);
  return page.url().split('/').pop()!;
}

/** 触发下载并读回 JSON 文本 */
async function downloadBackup(page: Page, testid: string): Promise<string> {
  const dl = page.waitForEvent('download');
  await page.click(`[data-testid="${testid}"]`);
  const path = await (await dl).path();
  return readFile(path!, 'utf-8');
}

test.describe('字帖备份与恢复', () => {
  test('导出选中 / 导出全部：文件含版本号、导出时间、份数', async ({ page }) => {
    await createWorksheet(page, '春天花会开');
    await createWorksheet(page, '日月水火');
    await page.goto('/');
    await expect(page.locator('.recent-item')).toHaveCount(2);

    // 导出选中 1 份
    await page.locator('[data-testid="select-worksheet"]').first().check();
    await expect(page.locator('[data-testid="export-selected"]')).toContainText('导出选中（1）');
    const one = JSON.parse(await downloadBackup(page, 'export-selected'));
    expect(one.version).toBe(1);
    expect(typeof one.exportedAt).toBe('number');
    expect(one.count).toBe(1);
    expect(one.worksheets).toHaveLength(1);
    expect(one.worksheets[0].chars.join('')).toBe('日月水火');

    // 取消勾选后按钮禁用；导出全部 2 份
    await page.locator('[data-testid="select-worksheet"]').first().uncheck();
    await expect(page.locator('[data-testid="export-selected"]')).toBeDisabled();
    const all = JSON.parse(await downloadBackup(page, 'export-all'));
    expect(all.count).toBe(2);
    expect(all.worksheets).toHaveLength(2);
  });

  test('清空本机后从备份恢复：新增统计正确', async ({ page }) => {
    await createWorksheet(page, '春天花会开');
    await createWorksheet(page, '日月水火');
    await page.goto('/');
    const backup = await downloadBackup(page, 'export-all');

    // 模拟换电脑/清数据：清空 localStorage
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.recent-item')).toHaveCount(0);

    await page.locator('[data-testid="import-backup"]').setInputFiles({
      name: '字帖备份.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backup),
    });
    await expect(page.locator('[data-testid="import-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="import-plan"]')).toContainText('共 2 份字帖可恢复');
    await expect(page.locator('[data-testid="conflict-list"]')).toHaveCount(0);
    await page.click('[data-testid="import-confirm"]');
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 2 份 · 覆盖 0 份 · 跳过 0 份');
    await expect(page.locator('.recent-item')).toHaveCount(2);
  });

  test('重复字帖：另存为新的一份 / 覆盖 / 跳过', async ({ page }) => {
    await createWorksheet(page, '春天花会开');
    await page.goto('/');
    const backup = await downloadBackup(page, 'export-all');

    // 第一次导入：与本机重复，默认另存为
    await page.locator('[data-testid="import-backup"]').setInputFiles({
      name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup),
    });
    await expect(page.locator('[data-testid="conflict-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="conflict-item"]')).toContainText('春天花会字帖');
    await page.click('[data-testid="import-confirm"]');
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 1 份 · 覆盖 0 份 · 跳过 0 份');
    await expect(page.locator('.recent-item')).toHaveCount(2);
    await expect(page.locator('.recent-item').first()).toContainText('（副本）');

    // 第二次导入：选覆盖
    await page.locator('[data-testid="import-backup"]').setInputFiles({
      name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup),
    });
    await page.locator('[data-testid="conflict-item"]').getByLabel('覆盖本机这份').check();
    await page.click('[data-testid="import-confirm"]');
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 0 份 · 覆盖 1 份 · 跳过 0 份');
    await expect(page.locator('.recent-item')).toHaveCount(2);

    // 第三次导入：选跳过
    await page.locator('[data-testid="import-backup"]').setInputFiles({
      name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup),
    });
    await page.locator('[data-testid="conflict-item"]').getByLabel('跳过').check();
    await page.click('[data-testid="import-confirm"]');
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 0 份 · 覆盖 0 份 · 跳过 1 份');
    await expect(page.locator('.recent-item')).toHaveCount(2);
  });

  test('坏文件逐条列出原因，只恢复没坏的', async ({ page }) => {
    await createWorksheet(page, '花木水');
    await page.goto('/');
    const good = JSON.parse(await downloadBackup(page, 'export-all'));
    const goodWs = good.worksheets[0];

    const badVersion = JSON.stringify({ ...good, version: 99 });
    const notJson = '这根本不是 JSON {{{';
    const missingTitle = { ...goodWs };
    delete missingTitle.title;
    const partial = JSON.stringify({
      ...good,
      count: 5, // 份数不符 → 提示
      worksheets: [missingTitle, { ...goodWs, id: 'fresh-1', title: '好字帖' }],
    });

    await page.locator('[data-testid="import-backup"]').setInputFiles([
      { name: '坏版本.json', mimeType: 'application/json', buffer: Buffer.from(badVersion) },
      { name: '不是JSON.json', mimeType: 'application/json', buffer: Buffer.from(notJson) },
      { name: '部分损坏.json', mimeType: 'application/json', buffer: Buffer.from(partial) },
    ]);

    const reports = page.locator('[data-testid="file-report"]');
    await expect(reports).toHaveCount(3);
    // 逐文件列出坏在哪
    await expect(reports.nth(0)).toContainText('坏版本.json');
    await expect(reports.nth(0)).toContainText('版本不兼容');
    await expect(reports.nth(1)).toContainText('不是JSON.json');
    await expect(reports.nth(1)).toContainText('不是有效的 JSON 文件');
    await expect(reports.nth(2)).toContainText('部分损坏.json');
    await expect(reports.nth(2)).toContainText('缺少字段 title');
    await expect(reports.nth(2)).toContainText('声明 5 份');
    await expect(reports.nth(2)).toContainText('其余 1 份可正常恢复');

    // 只恢复没坏的那 1 份；坏条目计入跳过
    await page.click('[data-testid="import-confirm"]');
    await expect(page.locator('[data-testid="import-summary"]')).toContainText('新增 1 份 · 覆盖 0 份 · 跳过 1 份');
    await expect(page.locator('.recent-item')).toHaveCount(2);
    await expect(page.locator('.recent-item').first()).toContainText('好字帖');
  });

  test('全部文件都坏：不进入恢复，只列原因', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-testid="import-backup"]').setInputFiles({
      name: '别的应用.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ app: 'other', version: 1, exportedAt: 1, count: 0, worksheets: [] })),
    });
    await expect(page.locator('[data-testid="file-report"]')).toContainText('不是本应用导出的字帖备份文件');
    await expect(page.locator('[data-testid="import-empty"]')).toContainText('没有可恢复的字帖');
    await page.click('[data-testid="import-cancel"]');
    await expect(page.locator('[data-testid="import-panel"]')).toHaveCount(0);
  });
});
