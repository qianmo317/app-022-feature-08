import { useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { parseInput } from '../lib/input';
import { strokeCountOf } from '../lib/data';
import { deleteWorksheet, listWorksheets, newId, saveWorksheet } from '../lib/storage';
import { defaultLayout } from '../lib/layout';
import {
  applyImport,
  parseBackup,
  serializeBackup,
  type ConflictAction,
  type EntryIssue,
  type ImportSummary,
} from '../lib/backup';
import type { Worksheet } from '../types';

/** 单个备份文件的解析报告（导入面板逐文件展示） */
type FileReport = {
  name: string;
  fatal: string[];
  warnings: string[];
  badEntries: EntryIssue[];
  validCount: number;
};

type ImportState = {
  reports: FileReport[];
  candidates: Worksheet[];
  /** 与本机重复的字帖 id → 老师选择的处理方式 */
  choices: Record<string, ConflictAction>;
};

function downloadJson(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function backupFilename(worksheets: Worksheet[]): string {
  const stamp = new Date().toISOString().slice(0, 10);
  if (worksheets.length === 1) {
    return `${worksheets[0].title.replace(/[\\/:*?"<>|]/g, '_')}-字帖.json`;
  }
  return `字帖备份-${worksheets.length}份-${stamp}.json`;
}

/** 首页：输入生字 → 生成字帖；展示最近字帖列表；备份导出/恢复导入 */
export default function Home(): JSX.Element {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [sortByStrokes, setSortByStrokes] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<Worksheet[]>(() => listWorksheets());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const preview = parseInput(text, { sortByStrokes, strokeCountOf });

  const create = () => {
    const chars = preview;
    if (chars.length === 0) {
      setError('请至少输入一个汉字、字母或数字');
      return;
    }
    setError('');
    const ws: Worksheet = {
      id: newId(),
      title: `${chars.slice(0, 4).join('')}字帖`,
      chars,
      layout: defaultLayout,
      pages: 0,
      updatedAt: Date.now(),
      sortByStrokes,
    };
    saveWorksheet(ws);
    navigate(`/worksheet/${ws.id}`);
  };

  const remove = (id: string) => {
    deleteWorksheet(id);
    setRecent(listWorksheets());
    setChecked((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleCheck = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportWorksheets = (worksheets: Worksheet[]) => {
    if (worksheets.length === 0) return;
    downloadJson(serializeBackup(worksheets), backupFilename(worksheets));
  };

  const exportSelected = () => exportWorksheets(recent.filter((w) => checked.has(w.id)));
  const exportAll = () => exportWorksheets(recent);

  const onImportFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // 允许再次选择同一个文件
    if (files.length === 0) return;
    setSummary(null);
    const reports: FileReport[] = [];
    const candidates: Worksheet[] = [];
    for (const f of files) {
      const parsed = parseBackup(await f.text());
      reports.push({
        name: f.name,
        fatal: parsed.fatal,
        warnings: parsed.warnings,
        badEntries: parsed.badEntries,
        validCount: parsed.valid.length,
      });
      candidates.push(...parsed.valid);
    }
    // 与本机重复的默认「另存为新的一份」，由老师逐份确认
    const existing = new Set(listWorksheets().map((w) => w.id));
    const choices: Record<string, ConflictAction> = {};
    for (const w of candidates) {
      if (existing.has(w.id)) choices[w.id] = 'copy';
    }
    setImportState({ reports, candidates, choices });
  };

  const confirmImport = () => {
    if (!importState) return;
    const broken = importState.reports.reduce((n, r) => n + r.badEntries.length, 0);
    const result = applyImport(importState.candidates, (w) => importState.choices[w.id] ?? 'copy');
    result.skipped += broken; // 坏条目计入跳过
    setSummary(result);
    setImportState(null);
    setChecked(new Set());
    setRecent(listWorksheets());
  };

  const conflicts = importState ? importState.candidates.filter((w) => w.id in importState.choices) : [];
  const setAllChoices = (action: ConflictAction) => {
    setImportState((prev) => {
      if (!prev) return prev;
      const choices = { ...prev.choices };
      for (const id of Object.keys(choices)) choices[id] = action;
      return { ...prev, choices };
    });
  };

  return (
    <div className="home">
      <header className="home-header">
        <h1>田字格字帖与笔顺生成</h1>
        <nav>
          <Link className="btn" to="/library" data-testid="to-library">模板库</Link>
        </nav>
      </header>

      <section className="home-create card">
        <h2>新建字帖</h2>
        <textarea
          data-testid="input-chars"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
          placeholder="输入或粘贴生字，如：春天 花朵 小鸟"
          rows={4}
        />
        <p className="hint">
          自动去除重复字（保留首次出现顺序）；支持汉字、字母与数字；没有笔顺数据的汉字会明确标注，不会伪造笔画。
        </p>
        <div className="field-row">
          <label>
            <input
              type="checkbox"
              data-testid="sort-strokes"
              checked={sortByStrokes}
              onChange={(e) => setSortByStrokes(e.target.checked)}
            />{' '}
            按笔画数排序
          </label>
          <span className="hint" data-testid="home-count">已识别 {preview.length} 个字</span>
        </div>
        {error && <p className="error" data-testid="home-error">{error}</p>}
        <button className="btn primary" data-testid="create" onClick={create}>生成字帖</button>
      </section>

      <section className="home-recent">
        <h2>最近字帖</h2>
        <div className="backup-bar">
          <button className="btn" data-testid="export-selected" disabled={checked.size === 0} onClick={exportSelected}>
            导出选中{checked.size > 0 ? `（${checked.size}）` : ''}
          </button>
          <button className="btn" data-testid="export-all" disabled={recent.length === 0} onClick={exportAll}>
            导出全部
          </button>
          <label className="file-btn" data-testid="import-label">
            导入备份
            <input type="file" multiple accept=".json,application/json" data-testid="import-backup" onChange={onImportFiles} />
          </label>
          <span className="hint">备份文件包含版本号、导出时间与份数，可换电脑恢复。</span>
        </div>

        {importState && (
          <div className="card import-panel" data-testid="import-panel">
            <h3>恢复备份</h3>
            {importState.reports.map((r) => (
              <div className="file-report" data-testid="file-report" key={r.name}>
                <strong>{r.name}</strong>
                {r.fatal.length === 0 && r.badEntries.length === 0 && r.warnings.length === 0 && (
                  <span className="hint"> 文件正常，包含 {r.validCount} 份。</span>
                )}
                {r.fatal.map((msg) => (
                  <p className="error" data-testid="file-fatal" key={msg}>文件损坏：{msg}</p>
                ))}
                {r.warnings.map((msg) => (
                  <p className="hint" data-testid="file-warning" key={msg}>提示：{msg}</p>
                ))}
                {r.badEntries.map((b) => (
                  <p className="error" data-testid="entry-issue" key={b.index}>
                    「{b.title}」已跳过：{b.problems.join('；')}
                  </p>
                ))}
                {r.fatal.length === 0 && r.badEntries.length > 0 && (
                  <p className="hint">该文件其余 {r.validCount} 份可正常恢复。</p>
                )}
              </div>
            ))}

            {importState.candidates.length === 0 ? (
              <p className="error" data-testid="import-empty">没有可恢复的字帖。</p>
            ) : (
              <>
                <p data-testid="import-plan">
                  共 {importState.candidates.length} 份字帖可恢复
                  {conflicts.length > 0 ? `，其中 ${conflicts.length} 份与本机已有字帖重复` : ''}。
                </p>
                {conflicts.length > 0 && (
                  <div className="conflict-list" data-testid="conflict-list">
                    <div className="field-row">
                      <span className="hint">重复的字帖请逐份选择处理方式：</span>
                      <button className="btn ghost" data-testid="all-copy" onClick={() => setAllChoices('copy')}>全部另存为</button>
                      <button className="btn ghost" data-testid="all-overwrite" onClick={() => setAllChoices('overwrite')}>全部覆盖</button>
                    </div>
                    {conflicts.map((w) => (
                      <div className="conflict-item" data-testid="conflict-item" key={w.id}>
                        <span className="conflict-title">{w.title}（{w.chars.length} 字）</span>
                        <label>
                          <input
                            type="radio"
                            name={`conflict-${w.id}`}
                            checked={importState.choices[w.id] === 'copy'}
                            onChange={() => setImportState((prev) => prev && { ...prev, choices: { ...prev.choices, [w.id]: 'copy' } })}
                          />{' '}
                          另存为新的一份
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`conflict-${w.id}`}
                            checked={importState.choices[w.id] === 'overwrite'}
                            onChange={() => setImportState((prev) => prev && { ...prev, choices: { ...prev.choices, [w.id]: 'overwrite' } })}
                          />{' '}
                          覆盖本机这份
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`conflict-${w.id}`}
                            checked={importState.choices[w.id] === 'skip'}
                            onChange={() => setImportState((prev) => prev && { ...prev, choices: { ...prev.choices, [w.id]: 'skip' } })}
                          />{' '}
                          跳过
                        </label>
                      </div>
                    ))}
                  </div>
                )}
                <div className="field-row">
                  <button className="btn primary" data-testid="import-confirm" onClick={confirmImport}>开始恢复</button>
                  <button className="btn" data-testid="import-cancel" onClick={() => setImportState(null)}>取消</button>
                </div>
              </>
            )}
            {importState.candidates.length === 0 && (
              <button className="btn" data-testid="import-cancel" onClick={() => setImportState(null)}>关闭</button>
            )}
          </div>
        )}

        {summary && (
          <div className="card import-summary" data-testid="import-summary">
            <strong>恢复完成：</strong>
            新增 {summary.added} 份 · 覆盖 {summary.overwritten} 份 · 跳过 {summary.skipped} 份
            <button className="btn ghost" data-testid="summary-close" onClick={() => setSummary(null)}>知道了</button>
          </div>
        )}

        {recent.length === 0 ? (
          <p className="hint">还没有字帖，先在上面新建，或去模板库看看。</p>
        ) : (
          <ul className="recent-list">
            {recent.map((w) => (
              <li key={w.id} className="card recent-item">
                <input
                  type="checkbox"
                  className="recent-check"
                  data-testid="select-worksheet"
                  checked={checked.has(w.id)}
                  onChange={() => toggleCheck(w.id)}
                  aria-label={`选择 ${w.title}`}
                />
                <div>
                  <strong>{w.title}</strong>
                  <span className="hint">
                    {w.chars.length} 字 · {w.pages || '?'} 页 · {new Date(w.updatedAt).toLocaleString('zh-CN')}
                  </span>
                  <div className="recent-chars">
                    {w.chars.slice(0, 20).join(' ')}
                    {w.chars.length > 20 ? '…' : ''}
                  </div>
                </div>
                <div className="recent-actions">
                  <Link className="btn" to={`/worksheet/${w.id}`} data-testid="open">打开</Link>
                  <Link className="btn ghost" to={`/play/${w.id}`}>笔顺</Link>
                  <button className="btn danger" onClick={() => remove(w.id)}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
