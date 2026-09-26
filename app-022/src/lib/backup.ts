/**
 * 字帖备份与恢复：导出为单个 JSON 文件（含版本号、导出时间、份数），
 * 导入时逐文件/逐条校验，坏条目跳过、好条目恢复，同 id 冲突由老师选择处理方式。
 * 本模块不触碰 DOM，方便单测。
 */
import type { Worksheet } from '../types';
import { listWorksheets, newId, saveWorksheet } from './storage';

export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'app022-worksheet-backup';

export type BackupFile = {
  app: string;
  version: number;
  exportedAt: number;
  count: number;
  worksheets: Worksheet[];
};

/** 组装备份文件对象 */
export function buildBackup(worksheets: Worksheet[], now = Date.now()): BackupFile {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now,
    count: worksheets.length,
    worksheets,
  };
}

/** 序列化为可下载的 JSON 文本 */
export function serializeBackup(worksheets: Worksheet[], now = Date.now()): string {
  return JSON.stringify(buildBackup(worksheets, now), null, 2);
}

export type EntryIssue = { index: number; title: string; problems: string[] };

export type FileParseResult = {
  /** 致命问题：整个文件无法恢复（逐条列出坏在哪） */
  fatal: string[];
  /** 非致命提示：不影响恢复（如份数不符） */
  warnings: string[];
  /** 通过校验、可恢复的字帖 */
  valid: Worksheet[];
  /** 校验失败被跳过的条目及原因 */
  badEntries: EntryIssue[];
};

const GRIDS = ['tian', 'mi', 'huigong', 'square', 'line'];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNum(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

/** 校验单份字帖，返回问题列表（空数组 = 有效） */
export function validateWorksheet(x: unknown): string[] {
  if (!isObj(x)) return ['不是有效的字帖对象'];
  const problems: string[] = [];
  if (typeof x.id !== 'string' || x.id.length === 0) problems.push('缺少字段 id（非空字符串）');
  if (typeof x.title !== 'string') problems.push('缺少字段 title（字符串）');
  if (!Array.isArray(x.chars) || x.chars.length === 0 || !x.chars.every((c) => typeof c === 'string' && c.length > 0)) {
    problems.push('缺少字段 chars（至少 1 个字的数组）');
  }
  if (!isObj(x.layout)) {
    problems.push('缺少字段 layout（版式对象）');
  } else {
    const l = x.layout;
    if (typeof l.grid !== 'string' || !GRIDS.includes(l.grid)) problems.push('layout.grid 不是有效的格子类型');
    for (const k of ['perLine', 'lines', 'cellMm', 'lineGapMm'] as const) {
      if (!isNum(l[k])) problems.push(`layout.${k} 应为数字`);
    }
    const mix = l.mix;
    if (!isObj(mix) || !['model', 'strokeSteps', 'trace', 'blank'].every((k) => isNum(mix[k]))) {
      problems.push('layout.mix 缺少 model/strokeSteps/trace/blank 数字');
    }
    const show = l.show;
    if (!isObj(show) || !['pinyin', 'radical', 'strokeCount', 'structure'].every((k) => typeof show[k] === 'boolean')) {
      problems.push('layout.show 缺少 pinyin/radical/strokeCount/structure 布尔值');
    }
    if (typeof l.traceColor !== 'string') problems.push('layout.traceColor 应为字符串');
  }
  if (!isNum(x.pages)) problems.push('缺少字段 pages（数字）');
  if (!isNum(x.updatedAt)) problems.push('缺少字段 updatedAt（数字）');
  if (x.pinyinChoice !== undefined && !isObj(x.pinyinChoice)) problems.push('pinyinChoice 应为对象');
  if (x.sortByStrokes !== undefined && typeof x.sortByStrokes !== 'boolean') problems.push('sortByStrokes 应为布尔值');
  return problems;
}

/** 解析一个备份文件：文件级问题进 fatal/warnings，条目级问题进 badEntries，好条目进 valid */
export function parseBackup(text: string): FileParseResult {
  const result: FileParseResult = { fatal: [], warnings: [], valid: [], badEntries: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    result.fatal.push('不是有效的 JSON 文件');
    return result;
  }
  if (!isObj(raw)) {
    result.fatal.push('文件内容不是对象结构');
    return result;
  }
  if (raw.app !== BACKUP_APP) {
    result.fatal.push('不是本应用导出的字帖备份文件（app 标识不符）');
  }
  if (!isNum(raw.version)) {
    result.fatal.push('缺少版本号 version');
  } else if (raw.version !== BACKUP_VERSION) {
    result.fatal.push(`版本不兼容：文件版本 ${String(raw.version)}，当前支持版本 ${BACKUP_VERSION}`);
  }
  if (!isNum(raw.exportedAt)) result.fatal.push('缺少导出时间 exportedAt');
  if (!Array.isArray(raw.worksheets)) result.fatal.push('缺少字帖列表 worksheets（数组）');
  if (result.fatal.length > 0) return result;

  const list = raw.worksheets as unknown[];
  if (!isNum(raw.count)) {
    result.warnings.push('缺少份数 count');
  } else if (raw.count !== list.length) {
    result.warnings.push(`文件声明 ${String(raw.count)} 份，实际包含 ${list.length} 份`);
  }

  list.forEach((item, index) => {
    const problems = validateWorksheet(item);
    if (problems.length === 0) {
      result.valid.push(item as Worksheet);
    } else {
      const title = isObj(item) && typeof item.title === 'string' && item.title ? item.title : `第 ${index + 1} 条`;
      result.badEntries.push({ index, title, problems });
    }
  });
  return result;
}

export type ConflictAction = 'overwrite' | 'copy' | 'skip';

export type ImportSummary = { added: number; overwritten: number; skipped: number };

/**
 * 把校验通过的字帖写入本机存储。
 * 同 id 已存在时调用 resolve 由老师决定：覆盖 / 另存为新的一份 / 跳过。
 */
export function applyImport(
  candidates: Worksheet[],
  resolve: (w: Worksheet, existing: Worksheet) => ConflictAction,
): ImportSummary {
  const summary: ImportSummary = { added: 0, overwritten: 0, skipped: 0 };
  const existing = new Map(listWorksheets().map((w) => [w.id, w]));
  for (const w of candidates) {
    const dup = existing.get(w.id);
    if (!dup) {
      saveWorksheet(w);
      existing.set(w.id, w);
      summary.added += 1;
      continue;
    }
    const action = resolve(w, dup);
    if (action === 'overwrite') {
      saveWorksheet(w);
      existing.set(w.id, w);
      summary.overwritten += 1;
    } else if (action === 'copy') {
      const copy: Worksheet = { ...w, id: newId(), title: `${w.title}（副本）`, updatedAt: Date.now() };
      saveWorksheet(copy);
      existing.set(copy.id, copy);
      summary.added += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}
