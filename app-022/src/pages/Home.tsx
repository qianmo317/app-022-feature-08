import { useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { parseInput } from '../lib/input';
import { strokeCountOf } from '../lib/data';
import { deleteWorksheet, listWorksheets, newId, saveWorksheet } from '../lib/storage';
import { defaultLayout } from '../lib/layout';
import { downloadBackup, reviewBackupFiles, type Review } from '../lib/backup';
import { ImportReviewModal } from '../components/ImportReviewModal';
import type { Worksheet } from '../types';

/** 首页：输入生字 → 生成字帖；展示最近字帖列表；字帖备份与恢复 */
export default function Home(): JSX.Element {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [sortByStrokes, setSortByStrokes] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<Worksheet[]>(() => listWorksheets());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [importMsg, setImportMsg] = useState('');

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
    setChecked((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    setRecent(listWorksheets());
  };

  const toggle = (id: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const checkedWorksheets = () => recent.filter((w) => checked.has(w.id));

  const exportChecked = () => {
    const ws = checkedWorksheets();
    if (ws.length === 0) return;
    downloadBackup(ws);
  };

  const exportAll = () => {
    if (recent.length === 0) return;
    setChecked(new Set(recent.map((w) => w.id)));
    downloadBackup(recent);
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImportMsg('');
    try {
      const payload = await Promise.all(
        Array.from(files).map(async (f) => ({ name: f.name, text: await f.text() })),
      );
      setReview(reviewBackupFiles(payload));
    } catch (err) {
      setImportMsg(`读取文件失败：${err instanceof Error ? err.message : String(err)}`);
    }
    e.target.value = '';
  };

  const closeModal = () => {
    setReview(null);
    setRecent(listWorksheets());
  };

  const allChecked = recent.length > 0 && checked.size === recent.length;
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(recent.map((w) => w.id)));
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
        <div className="recent-head">
          <h2>最近字帖</h2>
          {recent.length > 0 && (
            <div className="backup-actions">
              <label className="check-all">
                <input type="checkbox" data-testid="check-all" checked={allChecked} onChange={toggleAll} /> 全选
              </label>
              <button
                className="btn"
                data-testid="export-selected"
                onClick={exportChecked}
                disabled={checked.size === 0}
              >
                导出选中{checked.size > 0 ? `（${checked.size}）` : ''}
              </button>
              <button className="btn" data-testid="export-all" onClick={exportAll}>
                导出全部（{recent.length}）
              </button>
              <label className="file-btn">
                导入恢复
                <input
                  type="file"
                  accept=".json,application/json"
                  multiple
                  data-testid="import-backup"
                  onChange={onImportFile}
                />
              </label>
            </div>
          )}
        </div>
        {importMsg && <p className="error" data-testid="import-backup-msg">{importMsg}</p>}
        {recent.length === 0 ? (
          <div>
            <p className="hint">还没有字帖，先在上面新建，或去模板库看看。</p>
            <label className="file-btn">
              从备份文件导入恢复
              <input
                type="file"
                accept=".json,application/json"
                multiple
                data-testid="import-backup-empty"
                onChange={onImportFile}
              />
            </label>
          </div>
        ) : (
          <ul className="recent-list">
            {recent.map((w) => (
              <li key={w.id} className="card recent-item">
                <label className="recent-check" data-testid={`check-${w.id}`}>
                  <input type="checkbox" checked={checked.has(w.id)} onChange={() => toggle(w.id)} />
                </label>
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

      {review && <ImportReviewModal review={review} onClose={closeModal} />}
    </div>
  );
}
