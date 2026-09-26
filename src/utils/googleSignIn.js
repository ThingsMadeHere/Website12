// ── Google Identity Services loader ──────────────────────────────────────────
// Loads the official https://accounts.google.com/gsi/client script ON DEMAND
// (only when a sign-in screen actually renders with a configured client ID),
// then renders the real "Continue with Google" button into a container div.
//
// Flow: GIS gives us an ID token ("credential") → we POST it to
// /api/auth/google → the server verifies it with google-auth-library and
// returns our own session. No passwords, no OAuth redirect dance, no secret.
// Docs: https://developers.google.com/identity/gsi/web/guides/overview

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let loadPromise = null;

export function loadGoogleGSI() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    const script = existing || Object.assign(document.createElement('script'), {
      src: GSI_SRC, async: true, defer: true,
    });
    script.addEventListener('load', () => {
      if (window.google?.accounts?.id) resolve(window.google);
      else reject(new Error('Google script loaded but GIS API is unavailable.'));
    });
    script.addEventListener('error', () => {
      loadPromise = null; // allow retry after e.g. a transient network failure
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    });
    if (!existing) document.head.appendChild(script);
  });
  return loadPromise;
}

// Render the official Google button into `el`. Returns a cleanup fn that
// cancels the pending GIS prompt (safe to call even after unmount).
export async function renderGoogleButton(el, { clientId, onCredential }) {
  const google = await loadGoogleGSI();
  google.accounts.id.initialize({
    client_id: clientId,
    ux_mode: 'popup',          // no redirect URIs to configure anywhere
    auto_select: false,        // never sign anyone in without a click
    callback: (resp) => {
      if (resp?.credential) onCredential(resp.credential);
    },
  });
  // width ≈ the card width; GIS scales the label itself.
  google.accounts.id.renderButton(el, {
    theme: 'outline', size: 'large', width: Math.max(200, el.clientWidth || 260),
    text: 'continue_with', shape: 'pill', locale: 'en',
  });
  return () => { try { google.accounts.id.cancel(); } catch { /* already gone */ } };
}

// Exchange a Google ID token for one of our app sessions.
// Returns { ok, data } or { error, code? } — never throws for expected cases.
export async function postGoogleCredential(credential) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data };
    return { ok: false, code: data?.code, error: data?.error || `Sign-in failed (${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the server. Try again.' };
  }
}

// Silent re-auth using the HttpOnly mchs_gsid cookie set at the last Google
// sign-in (one click, no popup — great for shared Chromebooks).
export async function quickSignIn() {
  try {
    const res = await fetch('/api/auth/google/quick', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data };
    return { ok: false, code: data?.code, error: data?.error };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

// Does this browser remember a Google user? ({ remembered, username, ... })
export async function getQuickSignInStatus() {
  try {
    const res = await fetch('/api/auth/google/status');
    if (!res.ok) return { remembered: false };
    return await res.json();
  } catch {
    return { remembered: false };
  }
}
