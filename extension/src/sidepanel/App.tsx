import { useCallback, useEffect, useRef, useState } from 'react';
import { matchesPattern, type CompanionStatus, type OnboardingStatus, type SidebarState, type SiteScript } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';
import { Chat } from './Chat';
import { Manager } from './Manager';
import { Onboarding, allChecksPass, companionLabel } from './Onboarding';
import { usePage } from './usePage';
import { errorMessage, hostOf, truncate } from './util';

/** Longest page title shown in the strip. */
const STRIP_TITLE_MAX = 60;

/** The label in the page strip for a URL: its host, or a fixed label for file URLs. */
export function hostLabel(url: string): string {
  return hostOf(url) || 'Local file';
}

export type View = 'chat' | 'manager';

export interface AppProps {
  bridge: Bridge;
}

/**
 * True when the main UI may show. Either every onboarding check passes, or the
 * user finished onboarding before and the companion is connected now.
 */
export function isSetupComplete(status: OnboardingStatus | null, onboardingDone: boolean): boolean {
  if (allChecksPass(status)) return true;
  return onboardingDone && status?.companion.state === 'connected';
}

function dotClass(c: CompanionStatus): string {
  if (c.state === 'connected') return 'dot dot-ok';
  if (c.state === 'checking' || c.state === 'unknown') return 'dot dot-checking';
  return 'dot dot-fail';
}

export function App({ bridge }: AppProps) {
  const [state, setState] = useState<SidebarState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [view, setView] = useState<View>('chat');
  const [setupOpen, setSetupOpen] = useState(false);
  const [modifyTarget, setModifyTarget] = useState<SiteScript | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [footerError, setFooterError] = useState<string | null>(null);
  const page = usePage(bridge);

  // When the page changes, drop a Modify chip whose script no longer matches.
  // Only a page change triggers this. Picking Modify on any script keeps it.
  const pageUrl = page.tab?.url ?? null;
  useEffect(() => {
    if (pageUrl === null) return;
    setModifyTarget((t) => (t && !matchesPattern(t.urlPattern, pageUrl) ? null : t));
  }, [pageUrl]);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    bridge
      .request({ type: 'getState' })
      .then((s) => {
        if (!alive) return;
        setState(s);
        // Returning users get a quick check (no model call). The full check,
        // including the Claude login, runs only while the setup view is open.
        return bridge.request({ type: 'checkOnboarding', quick: s.settings.onboardingDone }).then((o) => {
          if (alive) {
            setOnboarding(o);
            setOnboardingError(null);
          }
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadError((current) => current ?? errorMessage(e));
        setOnboardingError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [bridge, attempt]);

  useEffect(
    () =>
      bridge.onEvent((ev) => {
        if (ev.type === 'stateChanged') {
          setState(ev.state);
        } else if (ev.type === 'companionStatus') {
          setState((s) => (s ? { ...s, companion: ev.status } : s));
          setOnboarding((o) => (o ? { ...o, companion: ev.status } : o));
        }
      }),
    [bridge],
  );

  // The first time every check passes, remember it. Later launches then only
  // need the companion to be connected.
  const markedDone = useRef(false);
  const allPass = allChecksPass(onboarding);
  const onboardingDone = state?.settings.onboardingDone ?? true;
  useEffect(() => {
    if (!allPass || onboardingDone || markedDone.current) return;
    markedDone.current = true;
    bridge
      .request({ type: 'setOnboardingDone', done: true })
      .then((s) => setState(s))
      .catch((e: unknown) => console.warn('Sitecraft: could not save onboarding state', e));
  }, [bridge, allPass, onboardingDone]);

  const handleStatus = useCallback((s: OnboardingStatus) => {
    setOnboarding(s);
    setOnboardingError(null);
  }, []);
  const handleModify = useCallback((s: SiteScript) => {
    setModifyTarget(s);
    setView('chat');
  }, []);
  const clearModify = useCallback(() => setModifyTarget(null), []);
  const closeSetup = useCallback(() => setSetupOpen(false), []);
  // Retry loads the state again and asks for the page again. Both can have
  // failed on the same lost connection.
  const retry = () => {
    setAttempt((n) => n + 1);
    page.refresh();
  };

  if (!state) {
    return (
      <div className="app">
        <header className="header">
          <div className="brand">
            <svg className="brand-logo" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" />
            </svg>
            Sitecraft
          </div>
        </header>
        <main className="main pad">
          {loadError ? (
            <div>
              <p className="error-text">{loadError}</p>
              <button type="button" className="btn" onClick={retry}>
                Retry
              </button>
            </div>
          ) : (
            <p className="muted">Loading.</p>
          )}
        </main>
      </div>
    );
  }

  const companion: CompanionStatus = state.companion.state === 'unknown' && onboarding ? onboarding.companion : state.companion;
  const setupComplete = isSetupComplete(onboarding, state.settings.onboardingDone);
  const checking = onboarding === null && onboardingError === null;
  // Before the first check answers, trust the saved flag so returning users
  // see the app at once instead of a blocking "Checking setup." screen.
  const optimistic = onboarding === null && state.settings.onboardingDone;
  const showOnboarding = setupOpen || (!optimistic && !setupComplete);
  const pageCount = pageUrl === null ? 0 : state.scripts.filter((s) => matchesPattern(s.urlPattern, pageUrl)).length;
  const devReload = () => {
    setFooterError(null);
    // The port drops while the extension reloads, so the reply may never
    // arrive. That disconnect is expected and the bridge reconnects on its
    // own. Any other answer, such as a build without the hook, is shown.
    bridge.request({ type: 'devReload' }).catch((e: unknown) => {
      const message = errorMessage(e);
      if (!message.startsWith('Disconnected')) setFooterError(message);
    });
  };

  return (
    <div className="app" data-mode={bridge.mode}>
      <header className="header">
        <div className="brand">
          <svg className="brand-logo" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" />
          </svg>
          Sitecraft
        </div>
        {!showOnboarding && (
          <nav className="tabs" aria-label="Views">
            <button
              type="button"
              className={view === 'chat' ? 'tab active' : 'tab'}
              data-testid="tab-chat"
              onClick={() => setView('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className={view === 'manager' ? 'tab active' : 'tab'}
              data-testid="tab-manager"
              onClick={() => setView('manager')}
            >
              Manager{pageCount > 0 ? ` (${pageCount})` : ''}
            </button>
          </nav>
        )}
      </header>

      {!showOnboarding && (
        <div className="page-strip" data-testid="page-strip" title={page.tab ? page.tab.title : undefined}>
          {page.tab ? (
            <>
              <span className="page-host">{hostLabel(page.tab.url)}</span>{' '}
              <span className="page-title">{truncate(page.tab.title.trim() || page.tab.url, STRIP_TITLE_MAX)}</span>
            </>
          ) : page.ready ? (
            <span className="muted">No web page is active. Open a site in this window.</span>
          ) : null}
        </div>
      )}

      <main className="main">
        {showOnboarding &&
          (checking ? (
            <p className="muted pad">Checking setup.</p>
          ) : (
            <Onboarding
              bridge={bridge}
              status={onboarding}
              onStatus={handleStatus}
              onState={setState}
              onDone={closeSetup}
              canClose={setupOpen && setupComplete}
              onClose={closeSetup}
            />
          ))}
        {/* Chat and Manager stay mounted while setup is shown, so a thread and
            an in-flight run survive a temporary gate (for example after a
            service worker restart). */}
        <div hidden={showOnboarding || view !== 'chat'} className="view">
          <Chat
            bridge={bridge}
            state={state}
            page={page}
            modifyTarget={modifyTarget}
            onModify={handleModify}
            onClearModify={clearModify}
            onState={setState}
          />
        </div>
        <div hidden={showOnboarding || view !== 'manager'} className="view">
          <Manager bridge={bridge} state={state} page={page.tab} onModify={handleModify} onState={setState} />
        </div>
      </main>

      <footer className="footer">
        <span className={dotClass(companion)} aria-hidden="true" />
        <span className="footer-label" title={companion.detail ?? companionLabel(companion)}>
          Companion: {companionLabel(companion).replace(/\s*\(v[^)]*\)$/, '')}
        </span>
        {bridge.mode === 'external' && (
          <button type="button" className="link" data-testid="dev-reload" title="Reload the extension" onClick={devReload}>
            Reload
          </button>
        )}
        {footerError && (
          <span className="error-text" data-testid="footer-error">
            {footerError}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="link" data-testid="footer-setup" onClick={() => setSetupOpen(true)}>
          Setup
        </button>
      </footer>
    </div>
  );
}
