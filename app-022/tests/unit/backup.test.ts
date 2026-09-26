import { describe, expect, it, beforeEach } from 'vitest';
import type { Worksheet } from '../../src/types';
import { defaultLayout } from '../../src/lib/layout';

// node 环境没有 localStorage，stub 一个
const store = new Map<string, string>();
type LS = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; clear: () => void };
(globalThis as { localStorage?: LS }).localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k)! : null),
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
  clear: () => void store.clear(),
};

function makeWs(id: string, title = `${id}字帖`): Worksheet {
  return {
    id,
    title,
    chars: ['春', '天'],
    layout: { ...defaultLayout },
    pages: 1,
    updatedAt: 1700000000000,
  };
}

describe('备份导出 buildBackup / serializeBackup', () => {
  it('文件包含版本号、导出时间与份数', async () => {
    const { buildBackup, BACKUP_VERSION, BACKUP_APP } = await import('../../src/lib/backup');
    const bk = buildBackup([makeWs('a'), makeWs('b')], 1699999999999);
    expect(bk.app).toBe(BACKUP_APP);
    expect(bk.version).toBe(BACKUP_VERSION);
    expect(bk.exportedAt).toBe(1699999999999);
    expect(bk.count).toBe(2);
    expect(bk.worksheets).toHaveLength(2);
  });

  it('导出 → 解析往返一致', async () => {
    const { serializeBackup, parseBackup } = await import('../../src/lib/backup');
    const list = [makeWs('a'), makeWs('b', '第二份')];
    const parsed = parseBackup(serializeBackup(list, 1699999999999));
    expect(parsed.fatal).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.badEntries).toEqual([]);
    expect(parsed.valid).toEqual(list);
  });
});

describe('备份解析 parseBackup：坏文件逐条列出原因', () => {
  it('非 JSON 文件', async () => {
    const { parseBackup } = await import('../../src/lib/backup');
    const r = parseBackup('这不是 json');
    expect(r.fatal.join()).toContain('JSON');
    expect(r.valid).toHaveLength(0);
  });

  it('版本对不上', async () => {
    const { parseBackup, BACKUP_VERSION } = await import('../../src/lib/backup');
    const r = parseBackup(JSON.stringify({
      app: 'app022-worksheet-backup',
      version: BACKUP_VERSION + 1,
      exportedAt: 1,
      count: 0,
      worksheets: [],
    }));
    expect(r.fatal.join()).toContain('版本不兼容');
    expect(r.fatal.join()).toContain(String(BACKUP_VERSION + 1));
  });

  it('缺版本号 / 缺导出时间 / 缺字帖列表', async () => {
    const { parseBackup, BACKUP_APP } = await import('../../src/lib/backup');
    const r = parseBackup(JSON.stringify({ app: BACKUP_APP }));
    expect(r.fatal.join()).toContain('版本号');
    expect(r.fatal.join()).toContain('导出时间');
    expect(r.fatal.join()).toContain('worksheets');
  });

  it('app 标识不符', async () => {
    const { parseBackup } = await import('../../src/lib/backup');
    const r = parseBackup(JSON.stringify({ app: 'other-app', version: 1, exportedAt: 1, count: 0, worksheets: [] }));
    expect(r.fatal.join()).toContain('不是本应用');
  });

  it('条目缺字段：坏条目跳过、好条目保留，份数不符给提示', async () => {
    const { parseBackup, BACKUP_APP, BACKUP_VERSION } = await import('../../src/lib/backup');
    const good = makeWs('good');
    const noTitle = { ...makeWs('bad1') } as Record<string, unknown>;
    delete noTitle.title;
    const badChars = { ...makeWs('bad2'), chars: [] };
    const badLayout = { ...makeWs('bad3'), layout: { grid: 'hexagon' } };
    const r = parseBackup(JSON.stringify({
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: 1,
      count: 9, // 与实际不符
      worksheets: [good, noTitle, badChars, badLayout],
    }));
    expect(r.fatal).toEqual([]);
    expect(r.warnings.join()).toContain('9');
    expect(r.valid).toEqual([good]);
    expect(r.badEntries).toHaveLength(3);
    expect(r.badEntries[0].problems.join()).toContain('title');
    expect(r.badEntries[1].problems.join()).toContain('chars');
    expect(r.badEntries[2].problems.join()).toContain('layout');
  });
});

describe('恢复 applyImport：新增 / 覆盖 / 另存为 / 跳过', () => {
  beforeEach(() => store.clear());

  it('无冲突直接新增；覆盖 / 另存为 / 跳过统计正确', async () => {
    const { applyImport } = await import('../../src/lib/backup');
    const { saveWorksheet, listWorksheets } = await import('../../src/lib/storage');
    saveWorksheet(makeWs('dup', '本机原有'));

    const incoming = [makeWs('new1'), makeWs('dup', '覆盖版'), makeWs('dup2', '跳过这份'), makeWs('dup3', '另存这份')];
    saveWorksheet(makeWs('dup2', '本机2'));
    saveWorksheet(makeWs('dup3', '本机3'));

    const summary = applyImport(incoming, (w) => {
      if (w.id === 'dup') return 'overwrite';
      if (w.id === 'dup3') return 'copy';
      return 'skip';
    });
    expect(summary).toEqual({ added: 2, overwritten: 1, skipped: 1 });

    const all = listWorksheets();
    expect(all.find((w) => w.id === 'new1')).toBeTruthy();
    expect(all.find((w) => w.id === 'dup')!.title).toBe('覆盖版'); // 被覆盖
    expect(all.find((w) => w.id === 'dup2')!.title).toBe('本机2'); // 跳过：保持原样
    const copies = all.filter((w) => w.title === '另存这份（副本）');
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe('dup3'); // 另存为新 id
    expect(all.find((w) => w.id === 'dup3')!.title).toBe('本机3'); // 原份保留
  });

  it('同一文件内重复 id 也会触发冲突处理', async () => {
    const { applyImport } = await import('../../src/lib/backup');
    const summary = applyImport([makeWs('x', '第一份'), makeWs('x', '第二份')], () => 'copy');
    expect(summary.added).toBe(2);
    const { listWorksheets } = await import('../../src/lib/storage');
    expect(listWorksheets()).toHaveLength(2);
  });
});
