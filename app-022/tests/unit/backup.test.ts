import { describe, expect, it, beforeEach } from 'vitest';
import {
  BACKUP_APP,
  BACKUP_VERSION,
  buildBackup,
  reviewBackupFiles,
  restoreBackup,
  serializeBackup,
  uniqueCopyTitle,
  validateWorksheet,
} from '../../src/lib/backup';
import { defaultLayout } from '../../src/lib/layout';
import type { Worksheet } from '../../src/types';

// node 环境没有 localStorage，stub 一个（与 data-import.test.ts 同款）
const store = new Map<string, string>();
type LS = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; clear: () => void };
(globalThis as { localStorage?: LS }).localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k)! : null),
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
  clear: () => void store.clear(),
};

const LS_KEY = 'app022:worksheets';

function mkWs(over: Partial<Worksheet> = {}): Worksheet {
  return {
    id: over.id ?? 'w1',
    title: over.title ?? '春天字帖',
    chars: over.chars ?? ['春', '天'],
    layout: over.layout ?? defaultLayout,
    pages: over.pages ?? 1,
    updatedAt: over.updatedAt ?? 1_700_000_000_000,
    pinyinChoice: over.pinyinChoice,
    sortByStrokes: over.sortByStrokes,
  };
}

function setLocal(list: Worksheet[]): void {
  store.set(LS_KEY, JSON.stringify(list));
}

function localIds(): string[] {
  return JSON.parse(store.get(LS_KEY) || '[]').map((w: Worksheet) => w.id);
}

describe('备份文件生成 buildBackup', () => {
  beforeEach(() => store.clear());

  it('写明标识、版本号、导出时间与包含份数', () => {
    const backup = buildBackup([mkWs({ id: 'a' }), mkWs({ id: 'b' })], new Date('2026-09-25T08:30:00.000Z'));
    expect(backup.app).toBe(BACKUP_APP);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.exportedAt).toBe('2026-09-25T08:30:00.000Z');
    expect(backup.count).toBe(2);
    expect(backup.worksheets).toHaveLength(2);
    expect(JSON.parse(serializeBackup(backup)).count).toBe(2); // 可序列化往返
  });
});

describe('备份文件解析 reviewBackupFiles', () => {
  beforeEach(() => store.clear());

  it('完好文件全部可读', () => {
    const text = serializeBackup(buildBackup([mkWs(), mkWs({ id: 'w2', title: '花帖' })]));
    const review = reviewBackupFiles([{ name: 'a.json', text }]);
    expect(review.items).toHaveLength(2);
    expect(review.fileErrors).toHaveLength(0);
    expect(review.entryErrors).toHaveLength(0);
  });

  it('JSON 无法解析 → 文件级错误，不影响其他文件', () => {
    const good = serializeBackup(buildBackup([mkWs({ id: 'g' })]));
    const review = reviewBackupFiles([
      { name: 'bad.json', text: '{不是json' },
      { name: 'good.json', text: good },
    ]);
    expect(review.fileErrors).toHaveLength(1);
    expect(review.fileErrors[0].fileName).toBe('bad.json');
    expect(review.fileErrors[0].errors.join()).toContain('JSON');
    expect(review.items.map((i) => i.worksheet.id)).toEqual(['g']);
  });

  it('版本号对不上 → 文件级错误，逐条说明哪个文件、坏在哪', () => {
    const backup = buildBackup([mkWs()]);
    (backup as { version: number }).version = 99;
    const review = reviewBackupFiles([{ name: 'v99.json', text: JSON.stringify(backup) }]);
    expect(review.items).toHaveLength(0);
    expect(review.fileErrors[0].fileName).toBe('v99.json');
    expect(review.fileErrors[0].errors.join()).toContain('v99');
  });

  it('缺少标识 / 缺导出时间 / count 对不上 → 文件级错误', () => {
    const b1 = { ...buildBackup([mkWs()]), app: 'other' };
    const b2 = { ...buildBackup([mkWs()]), exportedAt: 'not-a-date' };
    const b3 = { ...buildBackup([mkWs(), mkWs({ id: 'w2' })]), count: 5 };
    const review = reviewBackupFiles(
      [b1, b2, b3].map((b, i) => ({ name: `f${i}.json`, text: JSON.stringify(b) })),
    );
    expect(review.fileErrors).toHaveLength(3);
    expect(review.fileErrors[0].errors.join()).toContain('标识');
    expect(review.fileErrors[1].errors.join()).toContain('导出时间');
    expect(review.fileErrors[2].errors.join()).toContain('数量对不上');
  });

  it('条目缺字段 → 条目级错误，列出第几条、哪份、缺什么，好的照常可读', () => {
    const bad1 = { ...mkWs({ id: 'b1' }), title: '' } as unknown as Worksheet;
    const bad2 = { ...mkWs({ id: 'b2' }), layout: undefined } as unknown as Worksheet;
    const bad3 = { ...mkWs({ id: 'b3' }), chars: ['好'] } as Worksheet;
    delete (bad3 as { updatedAt?: number }).updatedAt;
    const text = JSON.stringify({
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      count: 4,
      worksheets: [bad1, mkWs({ id: 'ok' }), bad2, bad3],
    });
    const review = reviewBackupFiles([{ name: 'mix.json', text }]);
    expect(review.items.map((i) => i.worksheet.id)).toEqual(['ok']);
    expect(review.entryErrors).toHaveLength(3);
    expect(review.entryErrors[0].index).toBe(1);
    expect(review.entryErrors[0].errors.join()).toContain('title');
    expect(review.entryErrors[1].index).toBe(3);
    expect(review.entryErrors[1].errors.join()).toContain('layout');
    expect(review.entryErrors[2].index).toBe(4);
    expect(review.entryErrors[2].errors.join()).toContain('updatedAt');
  });

  it('layout 内层缺字段也能定位', () => {
    const bad = { ...mkWs(), layout: { ...defaultLayout, mix: { model: 1 } } } as Worksheet;
    expect(validateWorksheet(bad).join()).toContain('mix');
    const bad2 = { ...mkWs(), layout: { ...defaultLayout, grid: 'xxx' } } as unknown as Worksheet;
    expect(validateWorksheet(bad2).join()).toContain('grid');
  });

  it('多个文件中相同 id 只保留第一份，后续标记条目错误', () => {
    const t1 = serializeBackup(buildBackup([mkWs({ id: 'dup' })]));
    const t2 = serializeBackup(buildBackup([mkWs({ id: 'dup' }), mkWs({ id: 'uniq' })]));
    const review = reviewBackupFiles([
      { name: 't1.json', text: t1 },
      { name: 't2.json', text: t2 },
    ]);
    expect(review.items.map((i) => i.worksheet.id)).toEqual(['dup', 'uniq']);
    expect(review.entryErrors).toHaveLength(1);
    expect(review.entryErrors[0].fileName).toBe('t2.json');
  });
});

describe('恢复 restoreBackup', () => {
  beforeEach(() => store.clear());

  it('新字帖一律新增，冲突可覆盖、另存或跳过', () => {
    setLocal([mkWs({ id: 'local', title: '本机已有' })]);
    const backup = serializeBackup(
      buildBackup([
        mkWs({ id: 'local', title: '备份里的版本' }),
        mkWs({ id: 'fresh', title: '新字帖' }),
      ]),
    );
    const review = reviewBackupFiles([{ name: 'a.json', text: backup }]);
    expect(review.existingIds.has('local')).toBe(true);

    const result = restoreBackup(review, (item, exists) => {
      if (!exists) return 'overwrite'; // 新增
      return item.worksheet.id === 'local' ? 'overwrite' : 'skip';
    });
    expect(result).toEqual({ added: 1, overwritten: 1, skipped: 0 });
    const all = JSON.parse(store.get(LS_KEY)!) as Worksheet[];
    const local = all.find((w) => w.id === 'local')!;
    expect(local.title).toBe('备份里的版本'); // 已覆盖
    expect(all.some((w) => w.id === 'fresh')).toBe(true); // 新增
  });

  it('另存为新的一份：新 id、不重名标题，原字帖不动，计入新增', () => {
    setLocal([mkWs({ id: 'w1', title: '春天字帖' })]);
    const review = reviewBackupFiles([{ name: 'a.json', text: serializeBackup(buildBackup([mkWs()])) }]);
    const result = restoreBackup(review, () => 'copy');
    expect(result.added).toBe(1);
    expect(result.overwritten).toBe(0);
    const all = JSON.parse(store.get(LS_KEY)!) as Worksheet[];
    expect(all).toHaveLength(2);
    expect(all.filter((w) => w.id === 'w1')).toHaveLength(1);
    const copy = all.find((w) => w.id !== 'w1')!;
    expect(copy.title).toBe('春天字帖（副本）');
    expect(copy.chars).toEqual(['春', '天']);
  });

  it('副本标题已存在时自动递增编号', () => {
    setLocal([mkWs({ id: 'w1' }), mkWs({ id: 'c1', title: '春天字帖（副本）' })]);
    expect(uniqueCopyTitle('春天字帖')).toBe('春天字帖（副本 2）');
  });

  it('跳过冲突：本机字帖保持不变并计入跳过', () => {
    setLocal([mkWs({ id: 'w1', title: '原标题' })]);
    const review = reviewBackupFiles([{ name: 'a.json', text: serializeBackup(buildBackup([mkWs()])) }]);
    const result = restoreBackup(review, () => 'skip');
    expect(result).toEqual({ added: 0, overwritten: 0, skipped: 1 });
    const all = JSON.parse(store.get(LS_KEY)!) as Worksheet[];
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('原标题');
  });

  it('坏文件坏条目不参与恢复，能只恢复没坏的', () => {
    const badEntry = { ...mkWs({ id: 'bad' }), title: '' } as unknown as Worksheet;
    const text = JSON.stringify({
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      count: 2,
      worksheets: [badEntry, mkWs({ id: 'good' })],
    });
    const review = reviewBackupFiles([
      { name: 'broken.json', text: 'xxx' },
      { name: 'mix.json', text },
    ]);
    const result = restoreBackup(review, () => 'overwrite');
    expect(result).toEqual({ added: 1, overwritten: 0, skipped: 0 });
    expect(localIds()).toEqual(['good']);
  });
});
