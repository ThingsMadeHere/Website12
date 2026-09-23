import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Check for a service-worker update on every full page load. Without this,
// an old SW (e.g. the stale mchs-robotics-v1 cache) can keep serving old
// bundles indefinitely on ChromeOS/PWA installs because the browser only
// re-checks sw.js lazily (~24h). register() forces that check immediately;
// the new SW then claims clients and reloads the page once (see sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update().catch(() => {})
    }).catch(() => {})
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// One-time reload when a fresh service worker takes over, so users never sit
// on a half-old/half-new bundle. Guarded by sessionStorage to avoid loops.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_UPDATED') {
      const last = sessionStorage.getItem('sw-reloaded-at')
      const now = Date.now()
      if (!last || now - Number(last) > 10000) {
        sessionStorage.setItem('sw-reloaded-at', String(now))
        window.location.reload()
      }
    }
  })
}
