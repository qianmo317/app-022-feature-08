/**
 * 字帖备份与恢复：纯前端导出/导入单个 JSON 文件。
 *
 * 文件结构：
 * {
 *   app: 'tianzige-backup',
 *   version: 1,
 *   exportedAt: ISO 时间字符串,
 *   count: n,
 *   worksheets: Worksheet[]
 * }
 *
 * 解析时逐文件、逐条列出问题；坏文件不影响好文件，可只恢复没坏的那些。
 */
import type { Worksheet } from '../types';
import { listWorksheets, saveWorksheet } from './storage';

export const BACKUP_APP = 'tianzige-backup';
export const BACKUP_VERSION = 1;

/** 备份文件头 */
export type BackupFile = {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  count: number;
  worksheets: Worksheet[];
};

/** 一份可以正常恢复的字帖 */
export type ReviewItem = { worksheet: Worksheet };

/** 一条无效字帖记录（文件里的第几条、是哪份、坏在哪） */
export type EntryError = {
  fileName: string;
  /** 该文件内的 1 起始序号；无法定位条目时为 null */
  index: number | null;
  /** 尽量辨认出的标题或 id，便于老师对应 */
  label: string;
  errors: string[];
};

/** 文件级问题（整个文件无法读取/不识别，一条都恢复不了） */
export type FileError = { fileName: string; errors: string[] };

export type Review = {
  items: ReviewItem[];
  fileErrors: FileError[];
  entryErrors: EntryError[];
  /** 已在本机存在（id 相同）的条目 id 集合 */
  existingIds: Set<string>;
};

/** 冲突处理：覆盖本机同名（同 id）字帖 / 另存为新的一份 / 跳过这一份 */
export type ConflictChoice = 'overwrite' | 'copy' | 'skip';

export type RestoreResult = {
  added: number;
  overwritten: number;
  skipped: number;
};

/** 构造备份文件对象 */
export function buildBackup(worksheets: Worksheet[], now: Date = new Date()): BackupFile {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    count: worksheets.length,
    worksheets,
  };
}

/** 序列化为带缩进的 JSON 文本 */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const GRID_KINDS = ['tian', 'mi', 'huigong', 'square', 'line'];

/** 逐条校验一份字帖；返回字段问题清单（空数组 = 完好） */
export function validateWorksheet(w: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(w)) return ['不是有效的字帖对象'];

  if (typeof w.id !== 'string' || w.id.trim() === '') errors.push('缺少 id 字段或 id 为空');
  if (typeof w.title !== 'string' || w.title.trim() === '') errors.push('缺少 title 字段或标题为空');
  if (!Array.isArray(w.chars) || w.chars.length === 0) {
    errors.push('缺少 chars 字段或没有生字');
  } else if (!w.chars.every((c) => typeof c === 'string' && c.length > 0)) {
    errors.push('chars 必须全部是非空字符');
  }
  if (typeof w.updatedAt !== 'number' || !Number.isFinite(w.updatedAt)) {
    errors.push('缺少 updatedAt 字段或不是数字时间戳');
  }
  if (typeof w.pages !== 'number' || !Number.isFinite(w.pages)) {
    errors.push('缺少 pages 字段或不是数字');
  }

  const layout = w.layout;
  if (!isObject(layout)) {
    errors.push('缺少 layout 字段');
    return errors; // layout 缺失就不再逐项检查
  }
  if (typeof layout.grid !== 'string' || !GRID_KINDS.includes(layout.grid)) {
    errors.push('layout.grid 取值无法识别');
  }
  for (const key of ['perLine', 'lines', 'cellMm', 'lineGapMm'] as const) {
    const v = layout[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`layout.${key} 缺失或不是数字`);
  }
  const mix = layout.mix;
  if (!isObject(mix)) {
    errors.push('layout.mix 字段缺失');
  } else {
    for (const key of ['model', 'strokeSteps', 'trace', 'blank'] as const) {
      const v = mix[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`layout.mix.${key} 缺失或不是数字`);
    }
  }
  const show = layout.show;
  if (!isObject(show)) {
    errors.push('layout.show 字段缺失');
  } else {
    for (const key of ['pinyin', 'radical', 'strokeCount', 'structure'] as const) {
      if (typeof show[key] !== 'boolean') errors.push(`layout.show.${key} 缺失或不是布尔值`);
    }
  }
  if (typeof layout.traceColor !== 'string' || layout.traceColor.trim() === '') {
    errors.push('layout.traceColor 缺失或不是颜色值');
  }
  if (layout.fourLine !== undefined && typeof layout.fourLine !== 'boolean') {
    errors.push('layout.fourLine 必须是布尔值');
  }

  if (w.pinyinChoice !== undefined) {
    if (!isObject(w.pinyinChoice) || !Object.values(w.pinyinChoice).every((v) => typeof v === 'number')) {
      errors.push('pinyinChoice 必须是「字符 → 读音序号」的数字映射');
    }
  }
  if (w.sortByStrokes !== undefined && typeof w.sortByStrokes !== 'boolean') {
    errors.push('sortByStrokes 必须是布尔值');
  }
  return errors;
}

function entryLabel(raw: unknown): string {
  if (isObject(raw)) {
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '';
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
    if (title && id) return `${title}（id ${id}）`;
    if (title) return title;
    if (id) return `id ${id}`;
  }
  return '无法识别的字帖';
}

type ParsedFile =
  | { ok: true; backup: BackupFile }
  | { ok: false; errors: string[] };

function parseFile(text: string): ParsedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['文件不是合法 JSON（无法解析）'] };
  }
  if (!isObject(json)) {
    return { ok: false, errors: ['JSON 顶层必须是对象，实际不是备份文件'] };
  }
  if (json.app !== BACKUP_APP) {
    return { ok: false, errors: [`不是本应用的备份文件（缺少标识 ${BACKUP_APP}）`] };
  }
  if (typeof json.version !== 'number') {
    return { ok: false, errors: ['文件缺少 version 版本号'] };
  }
  if (json.version !== BACKUP_VERSION) {
    return {
      ok: false,
      errors: [`文件版本号 v${String(json.version)} 与当前支持的 v${BACKUP_VERSION} 不一致，无法恢复`],
    };
  }
  if (typeof json.exportedAt !== 'string' || Number.isNaN(Date.parse(json.exportedAt))) {
    return { ok: false, errors: ['文件缺少导出时间 exportedAt 或时间无法识别'] };
  }
  if (!Array.isArray(json.worksheets)) {
    return { ok: false, errors: ['文件缺少 worksheets 列表'] };
  }
  if (typeof json.count !== 'number' || json.count !== json.worksheets.length) {
    return {
      ok: false,
      errors: [
        `文件头声明包含 ${typeof json.count === 'number' ? json.count : '?'} 份，实际列表有 ${json.worksheets.length} 份，数量对不上`,
      ],
    };
  }
  return { ok: true, backup: json as unknown as BackupFile };
}

/**
 * 解析一个或多个备份文件文本。
 * 跨文件出现相同 id 时，只保留第一份，后续标记为条目错误（无法在一份列表里并存）。
 */
export function reviewBackupFiles(files: { name: string; text: string }[]): Review {
  const items: ReviewItem[] = [];
  const fileErrors: FileError[] = [];
  const entryErrors: EntryError[] = [];
  const seenIds = new Set<string>();
  const localIds = new Set(listWorksheets().map((w) => w.id));

  for (const file of files) {
    const parsed = parseFile(file.text);
    if (!parsed.ok) {
      fileErrors.push({ fileName: file.name, errors: parsed.errors });
      continue;
    }
    parsed.backup.worksheets.forEach((raw, i) => {
      const errors = validateWorksheet(raw);
      if (errors.length > 0) {
        entryErrors.push({ fileName: file.name, index: i + 1, label: entryLabel(raw), errors });
        return;
      }
      const w = raw as Worksheet;
      if (seenIds.has(w.id)) {
        entryErrors.push({
          fileName: file.name,
          index: i + 1,
          label: entryLabel(raw),
          errors: ['与本次选中的另一份备份里的字帖 id 重复，已保留先读到的一份；如需恢复请分两次导入'],
        });
        return;
      }
      seenIds.add(w.id);
      items.push({ worksheet: w });
    });
  }

  return { items, fileErrors, entryErrors, existingIds: localIds };
}

/** 本机是否已有同 id 的字帖（基于当前 localStorage） */
export function existsLocally(id: string): boolean {
  return listWorksheets().some((w) => w.id === id);
}

/** 生成不与现有字帖重名的副本标题 */
export function uniqueCopyTitle(base: string): string {
  const used = new Set(listWorksheets().map((w) => w.title));
  const root = base.replace(/（副本(?:\s*\d+)?）$/, '').trim() || '字帖';
  let title = `${root}（副本）`;
  let n = 2;
  while (used.has(title)) {
    title = `${root}（副本 ${n}）`;
    n += 1;
  }
  return title;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 执行恢复。chooser 对每一份字帖给出处理方式（通常只对本机已存在的条目询问）。
 * 只统计本次实际写入：新增 / 覆盖 / 跳过；另存为新的一份计入新增。
 */
export function restoreBackup(
  review: Review,
  chooser: (item: ReviewItem, exists: boolean) => ConflictChoice,
  now: number = Date.now(),
): RestoreResult {
  const result: RestoreResult = { added: 0, overwritten: 0, skipped: 0 };
  for (const { worksheet } of review.items) {
    const existed = existsLocally(worksheet.id);
    const choice = chooser({ worksheet }, existed);
    if (choice === 'skip') {
      result.skipped += 1;
      continue;
    }
    if (choice === 'overwrite') {
      // 按写入前的实际状态计数：原本就有算覆盖，没有算新增
      saveWorksheet({ ...worksheet, updatedAt: Math.max(worksheet.updatedAt, now) });
      if (existed) result.overwritten += 1;
      else result.added += 1;
    } else {
      // copy：保留原内容，换新 id 与不重名的标题
      const copy: Worksheet = {
        ...worksheet,
        id: newId(),
        title: uniqueCopyTitle(worksheet.title),
        updatedAt: Math.max(worksheet.updatedAt, now),
      };
      saveWorksheet(copy);
      result.added += 1;
    }
  }
  return result;
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeName(s: string): string {
  return (s || '字帖').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '字帖';
}

/** 备份文件名（不含扩展名）：单份用标题，多份用时间戳 */
export function backupFileName(worksheets: Worksheet[], now: Date = new Date()): string {
  if (worksheets.length === 1) return `${safeName(worksheets[0].title)}-备份-${fileStamp(now)}`;
  return `字帖备份${worksheets.length}份-${fileStamp(now)}`;
}

/** 触发浏览器下载备份文件 */
export function downloadBackup(worksheets: Worksheet[], now: Date = new Date()): void {
  const text = serializeBackup(buildBackup(worksheets, now));
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${backupFileName(worksheets, now)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
