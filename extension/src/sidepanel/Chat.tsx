import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SidebarRequest, SidebarState, SiteScript, TabInfo } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';
import { TabPicker } from './components/TabPicker';
import { errorMessage, mutate } from './util';

export interface ChatProps {
  bridge: Bridge;
  state: SidebarState;
  modifyTarget: SiteScript | null;
  onModify(script: SiteScript): void;
  onClearModify(): void;
  onState(state: SidebarState): void;
}

type ThreadItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'note'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'result'; scriptId: string; snapshot: SiteScript; isUpdate: boolean; tabId: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewItem = DistributiveOmit<ThreadItem, 'id'>;

type RunRequest = Extract<SidebarRequest, { type: 'runRequest' }>;

const CANCEL_GRACE_MS = 5000;

export function Chat(props: ChatProps) {
  const { bridge, state, modifyTarget, onModify, onClearModify, onState } = props;
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [text, setText] = useState('');
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const counter = useRef(0);
  const runIdRef = useRef<string | null>(null);
  const runTabRef = useRef<number | null>(null);
  const modifyRef = useRef<SiteScript | null>(modifyTarget);
  const clearModifyRef = useRef(onClearModify);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  modifyRef.current = modifyTarget;
  clearModifyRef.current = onClearModify;

  const push = useCallback((item: NewItem) => {
    counter.current += 1;
    const next: ThreadItem = { ...item, id: counter.current };
    setItems((prev) => [...prev, next]);
  }, []);

  const setRun = useCallback((id: string | null) => {
    runIdRef.current = id;
    setRunId(id);
  }, []);

  const loadTabs = useCallback(async () => {
    setTabsLoading(true);
    try {
      const [list, def] = await Promise.all([bridge.request({ type: 'listTabs' }), bridge.request({ type: 'getDefaultTab' })]);
      setTabs(list);
      setTabId((current) => {
        if (current !== null && list.some((t) => t.tabId === current)) return current;
        if (def && list.some((t) => t.tabId === def.tabId)) return def.tabId;
        return list[0]?.tabId ?? null;
      });
    } catch (e) {
      push({ kind: 'error', text: errorMessage(e) });
    } finally {
      setTabsLoading(false);
    }
  }, [bridge, push]);

  useEffect(() => {
    void loadTabs();
  }, [loadTabs]);

  useEffect(
    () =>
      bridge.onEvent((ev) => {
        if (ev.type === 'runProgress') {
          if (ev.runId === runIdRef.current) setProgress(ev.status);
          return;
        }
        if (ev.type !== 'runDone' || ev.runId !== runIdRef.current) return;
        if (cancelTimer.current) {
          clearTimeout(cancelTimer.current);
          cancelTimer.current = null;
        }
        setRun(null);
        setProgress(null);
        const usedTab = runTabRef.current ?? 0;
        if (ev.outcome.ok) {
          push({
            kind: 'result',
            scriptId: ev.outcome.script.id,
            snapshot: ev.outcome.script,
            isUpdate: ev.outcome.isUpdate,
            tabId: usedTab,
          });
          if (modifyRef.current) clearModifyRef.current();
        } else {
          push({ kind: 'error', text: ev.outcome.error });
        }
      }),
    [bridge, push, setRun],
  );

  useEffect(
    () => () => {
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
    },
    [],
  );

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, progress]);

  async function send(): Promise<void> {
    const request = text.trim();
    if (!request || sending || runIdRef.current) return;
    if (tabId === null) {
      push({ kind: 'error', text: 'Pick a tab first.' });
      return;
    }
    setSending(true);
    push({ kind: 'user', text: request });
    const req: RunRequest = modifyTarget
      ? { type: 'runRequest', tabId, text: request, targetScriptId: modifyTarget.id }
      : { type: 'runRequest', tabId, text: request };
    try {
      const started = await bridge.request(req);
      runTabRef.current = tabId;
      setRun(started.runId);
      setProgress('Starting');
      setText('');
    } catch (e) {
      push({ kind: 'error', text: errorMessage(e) });
    } finally {
      setSending(false);
    }
  }

  async function cancel(): Promise<void> {
    const id = runIdRef.current;
    if (!id) return;
    setProgress('Cancelling');
    try {
      await bridge.request({ type: 'cancelRun', runId: id });
    } catch (e) {
      push({ kind: 'error', text: errorMessage(e) });
    }
    if (cancelTimer.current) clearTimeout(cancelTimer.current);
    cancelTimer.current = setTimeout(() => {
      cancelTimer.current = null;
      if (runIdRef.current !== id) return;
      setRun(null);
      setProgress(null);
      push({ kind: 'note', text: 'Cancelled.' });
    }, CANCEL_GRACE_MS);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const running = runId !== null;

  return (
    <div className="chat">
      <TabPicker tabs={tabs} selectedTabId={tabId} onSelect={setTabId} onRefresh={() => void loadTabs()} loading={tabsLoading} />

      <div className="thread" ref={threadRef} data-testid="chat-thread">
        {items.length === 0 && (
          <p className="muted empty">Describe a change for the picked tab. Example: "Hide the promo banner".</p>
        )}
        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={item.id} className="msg msg-user">
                  {item.text}
                </div>
              );
            case 'note':
              return (
                <div key={item.id} className="msg msg-note">
                  {item.text}
                </div>
              );
            case 'error':
              return (
                <div key={item.id} className="msg msg-error" data-testid="chat-error">
                  {item.text}
                </div>
              );
            case 'result':
              return (
                <ResultCard
                  key={item.id}
                  item={item}
                  live={state.scripts.find((s) => s.id === item.scriptId)}
                  onKeep={() => mutate(bridge, { type: 'keepScript', id: item.scriptId }, onState)}
                  onUndo={() => mutate(bridge, { type: 'undoScript', id: item.scriptId, tabId: item.tabId }, onState)}
                  onModify={onModify}
                />
              );
            default:
              return null;
          }
        })}
        {progress && (
          <div className="msg msg-progress" data-testid="chat-progress">
            <span className="spinner" aria-hidden="true" /> {progress}
          </div>
        )}
      </div>

      {modifyTarget && (
        <div className="chip" data-testid="modify-chip">
          <span>Modifying: {modifyTarget.name}</span>
          <button type="button" className="chip-x" data-testid="modify-clear" aria-label="Stop modifying" onClick={onClearModify}>
            x
          </button>
        </div>
      )}

      <div className="composer">
        <textarea
          data-testid="chat-input"
          value={text}
          rows={3}
          disabled={running}
          placeholder={modifyTarget ? 'Describe the change to this script' : 'What should change on this site?'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="row">
          <button type="button" className="btn btn-primary" data-testid="chat-send" disabled={running || sending} onClick={() => void send()}>
            Send
          </button>
          {running && (
            <button type="button" className="btn" data-testid="chat-cancel" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
          <span className="muted hint">Enter sends. Shift+Enter adds a line.</span>
        </div>
      </div>
    </div>
  );
}

interface ResultCardProps {
  item: Extract<ThreadItem, { kind: 'result' }>;
  live: SiteScript | undefined;
  onKeep(): Promise<void>;
  onUndo(): Promise<void>;
  onModify(script: SiteScript): void;
}

function ResultCard({ item, live, onKeep, onUndo, onModify }: ResultCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const script = live ?? item.snapshot;

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  let status: string;
  if (!live) status = 'This script was deleted.';
  else if (!live.enabled) status = 'Undone. The script is off. Find it in Manager.';
  else if (live.trial) status = item.isUpdate ? 'Updated as a trial. The page was reloaded.' : 'Applied as a trial. The page was reloaded.';
  else status = 'Kept.';

  const canKeep = !!live && live.enabled && live.trial;
  const canUndo = !!live && live.enabled;

  return (
    <div className="msg msg-result" data-testid="result-card" data-script-id={item.scriptId}>
      <div className="result-head">
        <strong>{script.name}</strong>
        <span className={`badge badge-${script.kind}`}>{script.kind.toUpperCase()}</span>
        {live?.trial && <span className="badge badge-trial">Trial</span>}
      </div>
      {script.description && <p className="card-desc">{script.description}</p>}
      <div className="muted">
        <code className="pattern">{script.urlPattern}</code> Priority {script.priority}
      </div>
      <p className="result-status">{status}</p>
      <div className="row">
        <button type="button" className="btn btn-primary btn-small" data-testid="result-keep" disabled={busy || !canKeep} onClick={() => void run(onKeep)}>
          Keep
        </button>
        <button type="button" className="btn btn-small" data-testid="result-undo" disabled={busy || !canUndo} onClick={() => void run(onUndo)}>
          Undo
        </button>
        <button type="button" className="btn btn-small" data-testid="result-modify" disabled={!live} onClick={() => live && onModify(live)}>
          Modify
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
