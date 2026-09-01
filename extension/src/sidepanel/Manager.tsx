import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ImportResult, SidebarState, SiteScript } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';
import { ScriptCard } from './components/ScriptCard';
import { errorMessage, mutate } from './util';

export interface ManagerProps {
  bridge: Bridge;
  state: SidebarState;
  onModify(script: SiteScript): void;
  onState(state: SidebarState): void;
}

export interface ScriptGroup {
  host: string;
  scripts: SiteScript[];
}

/** Host label for a match pattern. Pure string work, no pattern validation. */
export function hostFromPattern(pattern: string): string {
  if (pattern === '<all_urls>') return 'All sites';
  const m = /^[^:]+:\/\/([^/]*)/.exec(pattern);
  if (!m) return pattern;
  const host = m[1] ?? '';
  return host === '' ? 'Local files' : host;
}

export function groupByHost(scripts: SiteScript[]): ScriptGroup[] {
  const map = new Map<string, SiteScript[]>();
  for (const s of scripts) {
    const host = hostFromPattern(s.urlPattern);
    const list = map.get(host);
    if (list) list.push(s);
    else map.set(host, [s]);
  }
  return [...map.entries()]
    .map(([host, list]) => ({
      host,
      scripts: [...list].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

type Panel = 'none' | 'export' | 'import';

function exportFileName(): string {
  return `sitecraft-scripts-${new Date().toISOString().slice(0, 10)}.json`;
}

export function Manager({ bridge, state, onModify, onState }: ManagerProps) {
  const [panel, setPanel] = useState<Panel>('none');
  const [panelError, setPanelError] = useState<string | null>(null);
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const exportRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (exportJson === null || typeof URL.createObjectURL !== 'function') {
      setExportUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([exportJson], { type: 'application/json' }));
    setExportUrl(url);
    return () => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    };
  }, [exportJson]);

  async function doExport(): Promise<void> {
    setPanelError(null);
    setCopied(false);
    try {
      const json = await bridge.request({ type: 'exportScripts' });
      setExportJson(json);
      setPanel('export');
    } catch (e) {
      setPanelError(errorMessage(e));
    }
  }

  async function copyExport(): Promise<void> {
    if (exportJson === null) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(exportJson);
      } else {
        exportRef.current?.select();
        document.execCommand('copy');
      }
      setCopied(true);
    } catch (e) {
      setPanelError(errorMessage(e));
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImportText(await file.text());
      setImportResult(null);
    } catch (err) {
      setPanelError(errorMessage(err));
    }
  }

  async function doImport(): Promise<void> {
    const json = importText.trim();
    if (!json) return;
    setBusy(true);
    setPanelError(null);
    try {
      const result = await bridge.request({ type: 'importScripts', json });
      setImportResult(result);
      onState(await bridge.request({ type: 'getState' }));
    } catch (e) {
      setPanelError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const groups = groupByHost(state.scripts);

  return (
    <div className="manager">
      <div className="row toolbar">
        <span className="muted">
          {state.scripts.length} {state.scripts.length === 1 ? 'script' : 'scripts'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-small" data-testid="export-button" onClick={() => void doExport()}>
          Export
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="import-button"
          onClick={() => {
            setPanelError(null);
            setPanel((p) => (p === 'import' ? 'none' : 'import'));
          }}
        >
          Import
        </button>
      </div>

      {panel === 'export' && exportJson !== null && (
        <section className="panel" data-testid="export-panel">
          <div className="row">
            <strong>Export</strong>
            <span className="spacer" />
            <button type="button" className="btn btn-small" data-testid="export-copy" onClick={() => void copyExport()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {exportUrl && (
              <a className="btn btn-small" data-testid="export-download" href={exportUrl} download={exportFileName()}>
                Download
              </a>
            )}
            <button type="button" className="btn btn-small" onClick={() => setPanel('none')}>
              Close
            </button>
          </div>
          <textarea
            ref={exportRef}
            data-testid="export-json"
            className="code"
            readOnly
            rows={8}
            value={exportJson}
            onFocus={(e) => e.currentTarget.select()}
          />
        </section>
      )}

      {panel === 'import' && (
        <section className="panel" data-testid="import-panel">
          <div className="row">
            <strong>Import</strong>
            <span className="spacer" />
            <button type="button" className="btn btn-small" onClick={() => setPanel('none')}>
              Close
            </button>
          </div>
          <p className="muted">Paste an export file or pick one. A script with a known id replaces the saved one.</p>
          <textarea
            data-testid="import-json"
            className="code"
            rows={6}
            value={importText}
            placeholder='{"format":"sitecraft-scripts", ...}'
            onChange={(e) => {
              setImportText(e.target.value);
              setImportResult(null);
            }}
          />
          <div className="row">
            <input type="file" accept="application/json,.json" data-testid="import-file" onChange={(e) => void onFile(e)} />
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-small"
              data-testid="import-submit"
              disabled={busy || !importText.trim()}
              onClick={() => void doImport()}
            >
              Import
            </button>
          </div>
          {importResult && (
            <div data-testid="import-result">
              <p>
                Imported {importResult.imported}. Skipped {importResult.skipped}.
              </p>
              {importResult.errors.length > 0 && (
                <ul className="error-list">
                  {importResult.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {panelError && <p className="error-text">{panelError}</p>}

      {groups.length === 0 ? (
        <p className="muted empty">No scripts yet. Ask for a change in Chat.</p>
      ) : (
        groups.map((group) => (
          <section key={group.host} className="group" data-testid="script-group" data-host={group.host}>
            <h3 className="group-title">{group.host}</h3>
            {group.scripts.map((s) => (
              <ScriptCard
                key={s.id}
                script={s}
                error={state.errors[s.id]}
                onToggle={(enabled) => mutate(bridge, { type: 'toggleScript', id: s.id, enabled }, onState)}
                onPriority={(priority) => mutate(bridge, { type: 'setPriority', id: s.id, priority }, onState)}
                onSaveCode={(code) => mutate(bridge, { type: 'updateCode', id: s.id, code }, onState)}
                onModify={() => onModify(s)}
                onDelete={() => mutate(bridge, { type: 'deleteScript', id: s.id }, onState)}
                onClearError={() => mutate(bridge, { type: 'clearError', id: s.id }, onState)}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
