import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EXTENSION_ID, errorMessage, type CompanionStatus, type OnboardingStatus, type SidebarState } from '@sitecraft/shared';
import type { Bridge } from '../lib/bridge';

export const POLL_INTERVAL_MS = 2000;
export const EXTENSION_DETAILS_URL = `chrome://extensions/?id=${EXTENSION_ID}`;

export interface OnboardingProps {
  bridge: Bridge;
  status: OnboardingStatus | null;
  onStatus(status: OnboardingStatus): void;
  onState(state: SidebarState): void;
  onDone(): void;
  canClose?: boolean;
  onClose?(): void;
}

export function allChecksPass(status: OnboardingStatus | null): boolean {
  return (
    status !== null &&
    status.userScriptsEnabled &&
    status.companion.state === 'connected' &&
    status.claudeLogin.state === 'ok'
  );
}

type RowState = 'ok' | 'fail' | 'checking';

/** Row state for a check: its pass value, 'checking', or anything else as a failure. */
function rowState(state: string, pass: string): RowState {
  if (state === pass) return 'ok';
  return state === 'checking' ? 'checking' : 'fail';
}

export function companionLabel(c: CompanionStatus): string {
  switch (c.state) {
    case 'connected':
      return c.companionVersion ? `Connected (v${c.companionVersion})` : 'Connected';
    case 'not-installed':
      return 'Not installed';
    case 'forbidden':
      return 'Blocked. The host manifest names a different extension id.';
    case 'error':
      return 'Error';
    case 'checking':
      return 'Checking';
    default:
      return 'Unknown';
  }
}

function loginLabel(l: OnboardingStatus['claudeLogin']): string {
  switch (l.state) {
    case 'ok':
      return 'Logged in';
    case 'error':
      return 'Not logged in';
    case 'checking':
      return 'Checking';
    default:
      return 'Unknown';
  }
}

function Row(props: { testId: string; step: number; title: string; state: RowState; statusText: string; children: ReactNode }) {
  return (
    <section className={`ob-row ob-${props.state}`} data-testid={props.testId} data-state={props.state}>
      <div className="ob-head">
        <span className={`dot dot-${props.state}`} aria-hidden="true" />
        <strong>
          {props.step}. {props.title}
        </strong>
        <span className="ob-status">{props.statusText}</span>
      </div>
      <div className="ob-body">{props.children}</div>
    </section>
  );
}

export function Onboarding(props: OnboardingProps) {
  const { bridge, status, onStatus, onState, onDone, canClose = false, onClose } = props;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await bridge.request({ type: 'checkOnboarding' });
      onStatus(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
    }
  }, [bridge, onStatus]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check]);

  async function retryCompanion(): Promise<void> {
    setError(null);
    try {
      const companion = await bridge.request({ type: 'checkCompanion' });
      if (status) onStatus({ ...status, companion });
    } catch (e) {
      setError(errorMessage(e));
    }
    await check();
  }

  function openDetails(): void {
    setError(null);
    bridge.request({ type: 'openUrl', url: EXTENSION_DETAILS_URL }).catch((e: unknown) => setError(errorMessage(e)));
  }

  async function finish(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const state = await bridge.request({ type: 'setOnboardingDone', done: true });
      onState(state);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const userScriptsState: RowState = status ? (status.userScriptsEnabled ? 'ok' : 'fail') : 'checking';
  const companionState = status ? rowState(status.companion.state, 'connected') : 'checking';
  const loginState = status ? rowState(status.claudeLogin.state, 'ok') : 'checking';
  const ready = allChecksPass(status);

  return (
    <div className="onboarding">
      <h2 className="ob-title">Set up Sitecraft</h2>
      <p className="muted">
        Three things need to be in place. Checks run every 2 seconds. Tip: <code>./setup</code> in the repo automates them.
      </p>

      <Row
        testId="onboarding-userscripts"
        step={1}
        title="Allow user scripts"
        state={userScriptsState}
        statusText={status ? (status.userScriptsEnabled ? 'Enabled' : 'Off') : 'Checking'}
      >
        <p>
          Open the extension details page. Turn on "Allow User Scripts". Then click "Update" at the top of chrome://extensions, so the
          extension restarts and registers your scripts. Chrome 138 and newer needs this switch.
        </p>
        <button type="button" className="btn btn-small" onClick={openDetails}>
          Open extension details
        </button>
      </Row>

      <Row
        testId="onboarding-companion"
        step={2}
        title="Install the companion"
        state={companionState}
        statusText={status ? companionLabel(status.companion) : 'Checking'}
      >
        <p>The companion runs the agent on your machine. Install it once from a terminal, in the Sitecraft source checkout.</p>
        <pre className="cmd">node companion/bin/sitecraft.js install</pre>
        <p className="muted">
          Once the package is published: <code>npx sitecraft install</code>
        </p>
        {status?.companion.detail && status.companion.state !== 'connected' && (
          <p className="error-text">{status.companion.detail}</p>
        )}
        <button type="button" className="btn btn-small" onClick={() => void retryCompanion()}>
          Retry
        </button>
      </Row>

      <Row
        testId="onboarding-login"
        step={3}
        title="Log in to Claude"
        state={loginState}
        statusText={status ? loginLabel(status.claudeLogin) : 'Checking'}
      >
        <p>
          Run <code>claude</code> in a terminal and log in. Then click Retry.
        </p>
        {status?.claudeLogin.detail && status.claudeLogin.state !== 'ok' && (
          <p className="error-text">{status.claudeLogin.detail}</p>
        )}
        <button type="button" className="btn btn-small" onClick={() => void check()}>
          Retry
        </button>
      </Row>

      {error && <p className="error-text">{error}</p>}

      <div className="row ob-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="onboarding-continue"
          disabled={!ready || saving}
          onClick={() => void finish()}
        >
          Continue
        </button>
        {canClose && onClose && (
          <button type="button" className="btn" data-testid="onboarding-close" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
