import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBridge } from '../lib/bridge';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App bridge={createBridge()} />
    </StrictMode>,
  );
}
