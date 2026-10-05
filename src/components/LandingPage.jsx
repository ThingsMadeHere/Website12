import { useState, useEffect, useRef, useCallback } from 'react';
import { CheckCircle, ArrowLeft, Mail } from 'lucide-react';
import logo from '../assets/output-onlinepngtools.png';

// ── Sign-in screen (magic link email authentication) ─────────────────────────
// Passwordless login: user enters email → magic link sent → click link → logged in.
// This replaces Google Sign-In for better accessibility (no Google account needed)
// and no password liability (no passwords stored).

export default function LandingPage({ onVerified, onBack }) {
  const [authStep, setAuthStep] = useState('form'); // 'form' | 'loading' | 'done'
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!email) {
      setError('Please enter your email address.');
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    
    setLoading(true);
    
    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      
      const data = await res.json();
      
      if (res.ok) {
        setAuthStep('done');
        setTimeout(() => {
          onVerified({
            username: 'pending',
            email: email,
            needsApproval: true,
          });
        }, 2000);
      } else {
        setError(data.error || 'Failed to send magic link. Please try again.');
        setLoading(false);
      }
    } catch (err) {
      setError('Could not connect to server. Please check your internet connection.');
      setLoading(false);
    }
  };

  const headline = authStep === 'done' ? 'Check your email!' : 'Team Portal';
  const subline = authStep === 'done'
    ? 'We sent a magic link to your email. Click it to sign in.'
    : 'Sign in with your email — no passwords to remember.';

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
                Check your email for the magic link!
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Click the link to sign in. If you don't see it, check your spam folder.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <p className="text-xs p-2.5 rounded" role="alert"
                   style={{ background: 'rgba(248,113,113,0.12)', color: '#b91c1c', border: '1px solid rgba(248,113,113,0.35)' }}>
                  {error}
                </p>
              )}

              <div className="space-y-1.5">
                <label htmlFor="email" className="text-xs font-medium block"
                     style={{ color: 'var(--text-primary)' }}>
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                        style={{ color: 'var(--text-muted)' }} />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-offset-1"
                    style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    required
                    autoFocus
                  />
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                  Enter the email address associated with your account.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', color: '#ffffff' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                {loading ? 'Sending...' : 'Send Magic Link'}
              </button>

              <p className="text-[11px] leading-relaxed text-center" style={{ color: 'var(--text-subtle)' }}>
                By signing in, you agree to our terms. Your first sign-in creates
                your account automatically; a team admin approves new members.
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
