import { useState } from 'react';
import { PRIORITIES, type Priority, type ScriptError, type SiteScript } from '@sitecraft/shared';
import { errorMessage, formatTime, truncate } from '../util';

/**
 * The edit and delete state of one card. The parent owns it, keyed by script
 * id, so an open editor and its draft survive when the card leaves the list
 * (a tab switch in page scope) or the list is rebuilt (a scope switch).
 */
export interface CardUi {
  editing: boolean;
  draft: string;
  confirmDelete: boolean;
}

export const CARD_UI_CLOSED: CardUi = { editing: false, draft: '', confirmDelete: false };

export interface ScriptCardProps {
  script: SiteScript;
  error?: ScriptError;
  ui: CardUi;
  onUi(patch: Partial<CardUi>): void;
  onToggle(enabled: boolean): Promise<void>;
  onPriority(priority: Priority): Promise<void>;
  onSaveCode(code: string): Promise<void>;
  onModify(): void;
  onDelete(): Promise<void>;
  onClearError(): Promise<void>;
}

export function ScriptCard(props: ScriptCardProps) {
  const { script, error, ui, onUi } = props;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={script.enabled ? 'card' : 'card card-off'} data-testid="script-card" data-script-id={script.id}>
      <header className="card-head">
        <label className="toggle" title={script.enabled ? 'Turn off' : 'Turn on'}>
          <input
            type="checkbox"
            data-testid="script-toggle"
            checked={script.enabled}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.checked;
              void run(() => props.onToggle(next));
            }}
          />
          <span className="card-name" title={script.name}>
            {script.name}
          </span>
        </label>
        <span className={`badge badge-${script.kind}`}>{script.kind.toUpperCase()}</span>
        {script.trial && (
          <span className="badge badge-trial" data-testid="script-trial" title="Not kept yet">
            Trial
          </span>
        )}
      </header>
      {script.description && <p className="card-desc">{script.description}</p>}
      <div className="card-meta">
        <code className="pattern" title={script.urlPattern}>
          {truncate(script.urlPattern, 48)}
        </code>
        <label className="prio">
          Priority
          <select
            data-testid="script-priority"
            value={script.priority}
            disabled={busy}
            onChange={(e) => {
              const n = Number(e.target.value);
              const p = PRIORITIES.find((x) => x === n);
              if (p) void run(() => props.onPriority(p));
            }}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      {ui.editing ? (
        <div className="card-edit">
          <textarea
            data-testid="script-code"
            className="code"
            value={ui.draft}
            rows={8}
            spellCheck={false}
            onChange={(e) => onUi({ draft: e.target.value })}
          />
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-small"
              data-testid="script-save"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await props.onSaveCode(ui.draft);
                  onUi({ editing: false });
                })
              }
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-small"
              data-testid="script-cancel-edit"
              onClick={() => onUi({ editing: false, draft: script.code })}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row card-actions">
          <button
            type="button"
            className="btn btn-small"
            data-testid="script-edit"
            onClick={() => onUi({ editing: true, draft: script.code })}
          >
            Edit code
          </button>
          <button type="button" className="btn btn-small" data-testid="script-modify" onClick={props.onModify}>
            Modify with AI
          </button>
          {ui.confirmDelete ? (
            <span className="confirm">
              <span>Delete?</span>
              <button
                type="button"
                className="btn btn-small btn-danger"
                data-testid="script-delete-confirm"
                disabled={busy}
                onClick={() => void run(() => props.onDelete())}
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-small"
                data-testid="script-delete-cancel"
                onClick={() => onUi({ confirmDelete: false })}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-small btn-quiet-danger"
              data-testid="script-delete"
              onClick={() => onUi({ confirmDelete: true })}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="card-error" data-testid="script-error">
          <div>
            <strong>Last error:</strong> {error.message}
          </div>
          <div className="muted">
            {truncate(error.url, 60)} at {formatTime(error.at)}
          </div>
          <button
            type="button"
            className="btn btn-small"
            data-testid="script-error-clear"
            disabled={busy}
            onClick={() => void run(() => props.onClearError())}
          >
            Clear
          </button>
        </div>
      )}
      {actionError && <p className="error-text">{actionError}</p>}
    </article>
  );
}
