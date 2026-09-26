import { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle, ArrowLeft } from 'lucide-react';
import logo from '../assets/output-onlinepngtools.png';
import {
  renderGoogleButton, postGoogleCredential, quickSignIn, getQuickSignInStatus,
} from '../utils/googleSignIn';

// ── Sign-in screen (Google accounts only) ────────────────────────────────────
// Custom accounts are gone: no usernames, passwords, or team keys. One tap on
// the official "Continue with Google" button signs a student in; the server
// verifies the ID token and gates access by school email domain. Returning
// users get a one-click "Continue as …" (silent re-auth via HttpOnly cookie),
// which keeps shared/kiosk Chromebooks fast. If GOOGLE_CLIENT_ID isn't set on
// the server yet, we show a clear setup message instead of a dead button.

export default function LandingPage({ onVerified, onBack }) {
  const [authStep, setAuthStep] = useState('form'); // 'form' | 'loading' | 'done'
  const [error, setError]       = useState('');
  const [config, setConfig]     = useState(null);   // { googleEnabled, googleClientId } | null while loading
  const [remembered, setRemembered] = useState(null); // { username, fullName } | null
  const btnRef = useRef(null);
  const cancelGsi = useRef(null);

  // What sign-in methods does this server have enabled?
  useEffect(() => {
    let dead = false;
    fetch('/api/auth/config')
      .then(r => r.json())
      .then(c => { if (!dead) setConfig(c); })
      .catch(() => { if (!dead) setConfig({ googleEnabled: false }); });
    return () => { dead = true; };
  }, []);

  // Does this browser already remember a Google user? (one-click re-entry)
  useEffect(() => {
    let dead = false;
    getQuickSignInStatus().then(s => {
      if (!dead && s?.remembered && s.verified) setRemembered(s);
    });
    return () => { dead = true; };
  }, []);

  const finish = useCallback((data) => {
    setAuthStep('done');
    setTimeout(() => onVerified(data), 600);
  }, [onVerified]);

  const handleCredential = useCallback(async (credential) => {
    setError('');
    setAuthStep('loading');
    const r = await postGoogleCredential(credential);
    if (r.ok) return finish(r.data);
    setAuthStep('form');
    setError(r.error || 'Google sign-in failed. Please try again.');
  }, [finish]);

  // Render the real Google button once we know the client ID.
  useEffect(() => {
    if (!config?.googleEnabled || authStep !== 'form' || !btnRef.current) return undefined;
    let dead = false;
    renderGoogleButton(btnRef.current, {
      clientId: config.googleClientId,
      onCredential: (c) => { if (!dead) handleCredential(c); },
    })
      .then((cleanup) => { if (dead) cleanup(); else cancelGsi.current = cleanup; })
      .catch(() => { if (!dead) setError('Could not load Google sign-in. Check your internet connection and try again.'); });
    return () => {
      dead = true;
      if (cancelGsi.current) { cancelGsi.current(); cancelGsi.current = null; }
    };
  }, [config, authStep, handleCredential]);

  const handleQuick = async () => {
    setError('');
    setAuthStep('loading');
    const r = await quickSignIn();
    if (r.ok) return finish(r.data);
    setAuthStep('form');
    if (r.code === 'pending') setError('Your account is still waiting for an admin to approve it.');
    else setError(r.error || 'One-tap sign-in did not work — use the Google button below.');
  };

  const headline = authStep === 'done' ? 'Welcome to the team!' : 'Team Portal';
  const subline = authStep === 'done'
    ? 'Signed in with your school Google account.'
    : 'Sign in with your school Google account — no passwords to remember.';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Header */}
      <header className="px-4 sm:px-8 h-14 flex items-center justify-between shrink-0"
              style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          {onBack && (
            <button onClick={onBack} title="Back to site"
              className="p-1.5 -ml-1.5 rounded transition-colors flex items-center gap-1"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
              <ArrowLeft className="w-4 h-4" />
              <span className="text-xs hidden sm:inline">Back</span>
            </button>
          )}
          <img src={logo} alt="Logo" className="h-7 w-7 object-contain" style={{ filter: 'brightness(0)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>MCHS Robotics</span>
        </div>
        <span className="text-xs hidden sm:inline" style={{ color: 'var(--gold)' }}>Team 5728</span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pb-10 sm:pb-16"
            style={{ paddingTop: 'clamp(2rem, 6vh, 5rem)' }}>
        <img src={logo} alt="MCHS Robotics" className="w-20 h-20 sm:w-28 sm:h-28 object-contain mb-6 sm:mb-8"
             style={{ filter: 'brightness(0)', opacity: 0.92 }} />

        <div className="text-center mb-8 sm:mb-10 px-4">
          <h1 className="text-2xl sm:text-3xl font-semibold mb-2"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            {headline}
          </h1>
          <p className="text-sm max-w-sm mx-auto" style={{ color: 'var(--text-muted)' }}>{subline}</p>
        </div>

        {/* Card */}
        <div className="w-full max-w-sm rounded-xl p-5 sm:p-6"
             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>

          {authStep === 'done' ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CheckCircle className="w-10 h-10" style={{ color: 'var(--accent)' }} />
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                You're signed in — taking you to the board…
              </p>
            </div>
          ) : authStep === 'loading' ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="w-8 h-8 rounded-full animate-spin"
                   style={{ border: '3px solid var(--border)', borderTopColor: 'var(--accent)' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Signing you in…</p>
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <p className="text-xs p-2.5 rounded" role="alert"
                   style={{ background: 'rgba(248,113,113,0.12)', color: '#b91c1c', border: '1px solid rgba(248,113,113,0.35)' }}>
                  {error}
                </p>
              )}

              {/* One-click return for browsers that already signed in with Google */}
              {remembered && (
                <button onClick={handleQuick}
                        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors"
                        style={{ background: 'var(--accent)', color: '#ffffff' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                  Continue as {remembered.fullName || `@${remembered.username}`}
                </button>
              )}

              {/* Official Google Identity Services button */}
              {config && !config.googleEnabled ? (
                <p className="text-xs leading-relaxed p-3 rounded"
                   style={{ background: 'var(--bg-overlay)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                  Sign-in isn't configured on this server yet. An admin needs to set{' '}
                  <code>GOOGLE_CLIENT_ID</code> in <code>api/.env</code> (see{' '}
                  <code>api/.env.example</code>).
                </p>
              ) : (
                <div ref={btnRef} className="flex justify-center min-h-[44px]" aria-label="Continue with Google" />
              )}

              <p className="text-[11px] leading-relaxed text-center" style={{ color: 'var(--text-subtle)' }}>
                Use your school Google account (@mcsd47.org). Your first sign-in creates
                your account automatically; a team admin approves new members.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
