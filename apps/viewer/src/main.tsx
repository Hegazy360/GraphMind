import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { captureTokenFromLocation } from './connection/auth.js';
import './index.css';

// Before anything reads `location.hash` (the router, deep links): take the
// control token out of the address bar and keep it (connection/auth.ts).
// Also on a same-document navigation to `#token=…` (an already-open tab):
// registered before the app mounts, so it runs before the router's listener.
captureTokenFromLocation();
window.addEventListener('hashchange', () => {
  captureTokenFromLocation();
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
