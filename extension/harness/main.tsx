/**
 * Dev harness: the same App as the side panel, served as a normal web page at
 * http://localhost:4173/harness/ and connected through externally_connectable.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBridge } from '../src/lib/bridge';
import { App } from '../src/sidepanel/App';
import '../src/sidepanel/styles.css';

const container = document.getElementById('root');
if (container) {
  const bridge = createBridge();
  createRoot(container).render(
    <StrictMode>
      <div className="harness-shell">
        <header className="harness-header">
          <strong>Sitecraft Harness</strong>
          <span className="muted">bridge: {bridge.mode}</span>
        </header>
        <div className="harness-panel">
          <App bridge={bridge} />
        </div>
      </div>
    </StrictMode>,
  );
}
