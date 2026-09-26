import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { ConflictChoice, Review, ReviewItem, RestoreResult } from '../lib/backup';
import { existsLocally, restoreBackup } from '../lib/backup';

const CHOICE_LABEL: Record<ConflictChoice, string> = {
  overwrite: '覆盖本机字帖',
  copy: '另存为新的一份',
  skip: '跳过这一份',
};

/**
 * 恢复对话框：先列文件级 / 条目级问题（坏文件、坏条目不参与恢复），
 * 再对每份好字帖选择处理方式（仅本机已存在同 id 字帖时需要老师选择，默认另存）。
 */
export function ImportReviewModal({
  review,
  onClose,
}: {
  review: Review;
  onClose: () => void;
}): JSX.Element {
  // 默认：新增直接恢复；冲突默认「另存为新的一份」，避免静默覆盖老师本机内容
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [done, setDone] = useState<RestoreResult | null>(null);

  const choiceOf = (item: ReviewItem, exists: boolean): ConflictChoice =>
    choices[item.worksheet.id] ?? (exists ? 'copy' : 'overwrite');

  const conflictCount = useMemo(
    () => review.items.filter((it) => review.existingIds.has(it.worksheet.id)).length,
    [review],
  );
  const newCount = review.items.length - conflictCount;

  const doRestore = () => {
    const result = restoreBackup(review, (item, exists) => choiceOf(item, exists));
    setDone(result);
  };

  return (
    <div className="modal-mask" data-testid="import-modal">
      <div className="modal card">
        <h2 data-testid="import-title">恢复字帖</h2>

        {!done ? (
          <>
            <p className="hint" data-testid="import-summary">
              可读字帖 {review.items.length} 份（新增 {newCount} 份、本机已有 {conflictCount} 份）
              {review.fileErrors.length + review.entryErrors.length > 0
                ? `；${review.fileErrors.length + review.entryErrors.length} 处问题已跳过`
                : '；没有发现问题'}
            </p>

            {(review.fileErrors.length > 0 || review.entryErrors.length > 0) && (
              <div className="modal-errors" data-testid="import-errors">
                {review.fileErrors.map((fe, i) => (
                  <div className="import-error" key={`f${i}`} data-testid="file-error">
                    <strong>文件「{fe.fileName}」无法读取，整份跳过：</strong>
                    <ul>
                      {fe.errors.map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                {review.entryErrors.map((ee, i) => (
                  <div className="import-error" key={`e${i}`} data-testid="entry-error">
                    <strong>
                      文件「{ee.fileName}」第 {ee.index ?? '?'} 份 · {ee.label} 已损坏，跳过：
                    </strong>
                    <ul>
                      {ee.errors.map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {review.items.length > 0 && (
              <ul className="import-list" data-testid="import-items">
                {review.items.map((item) => {
                  const id = item.worksheet.id;
                  const exists = review.existingIds.has(id) || existsLocally(id);
                  const choice = choiceOf(item, exists);
                  return (
                    <li key={id} className="import-item" data-testid="import-item" data-conflict={exists}>
                      <div>
                        <strong>{item.worksheet.title}</strong>
                        <span className="hint">
                          {' '}
                          {item.worksheet.chars.length} 字 ·{' '}
                          {exists ? '本机已有同一份字帖' : '新字帖'}
                        </span>
                      </div>
                      {exists && (
                        <div className="import-choices" data-testid={`conflict-${id}`}>
                          {(Object.keys(CHOICE_LABEL) as ConflictChoice[]).map((c) => (
                            <label key={c}>
                              <input
                                type="radio"
                                name={`conflict-${id}`}
                                data-testid={`conflict-${id}-${c}`}
                                checked={choice === c}
                                onChange={() => setChoices((m) => ({ ...m, [id]: c }))}
                              />
                              {CHOICE_LABEL[c]}
                            </label>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="modal-actions">
              <button className="btn" data-testid="import-cancel" onClick={onClose}>
                {review.items.length === 0 ? '关闭' : '取消'}
              </button>
              {review.items.length > 0 && (
                <button className="btn primary" data-testid="import-restore" onClick={doRestore}>
                  开始恢复（{review.items.length} 份）
                </button>
              )}
            </div>
          </>
        ) : (
          <div data-testid="import-result">
            <p>
              恢复完成：新增 <b data-testid="result-added">{done.added}</b> 份、覆盖{' '}
              <b data-testid="result-overwritten">{done.overwritten}</b> 份、跳过{' '}
              <b data-testid="result-skipped">{done.skipped}</b> 份。
            </p>
            {(review.fileErrors.length > 0 || review.entryErrors.length > 0) && (
              <p className="hint">
                另有 {review.fileErrors.length} 个坏文件、{review.entryErrors.length} 份坏字帖未恢复。
              </p>
            )}
            <div className="modal-actions">
              <button className="btn primary" data-testid="import-done" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
