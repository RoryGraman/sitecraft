import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionStatus, OnboardingStatus, SidebarState, SiteScript } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';
import { Chat } from './Chat';
import { Manager } from './Manager';
import { Onboarding, allChecksPass, companionLabel } from './Onboarding';
import { errorMessage } from './util';

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

  if (!state) {
    return (
      <div className="app">
        <header className="header">
          <div className="brand">Sitecraft</div>
        </header>
        <main className="main pad">
          {loadError ? (
            <div>
              <p className="error-text">{loadError}</p>
              <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
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

  return (
    <div className="app" data-mode={bridge.mode}>
      <header className="header">
        <div className="brand">Sitecraft</div>
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
              Manager{state.scripts.length > 0 ? ` (${state.scripts.length})` : ''}
            </button>
          </nav>
        )}
      </header>

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
            modifyTarget={modifyTarget}
            onModify={handleModify}
            onClearModify={clearModify}
            onState={setState}
          />
        </div>
        <div hidden={showOnboarding || view !== 'manager'} className="view">
          <Manager bridge={bridge} state={state} onModify={handleModify} onState={setState} />
        </div>
      </main>

      <footer className="footer">
        <span className={dotClass(companion)} aria-hidden="true" />
        <span title={companion.detail ?? ''}>Companion: {companionLabel(companion)}</span>
        {bridge.mode === 'external' && <span className="muted">Harness</span>}
        <span className="spacer" />
        <button type="button" className="link" data-testid="footer-setup" onClick={() => setSetupOpen(true)}>
          Setup
        </button>
      </footer>
    </div>
  );
}
