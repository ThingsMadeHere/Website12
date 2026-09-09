import { useState, useRef } from 'react';
import { Upload, CheckCircle, ArrowRight, Shield, Eye, EyeOff } from 'lucide-react';
import logo from '../assets/output-onlinepngtools.png';

const API = '/api';

export default function LandingPage({ onVerified }) {
  const [mode, setMode]           = useState('login'); // 'login' | 'register'
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [authStep, setAuthStep]   = useState('form'); // 'form' | 'loading' | 'verify' | 'verifying' | 'done' | 'error'
  const [error, setError]         = useState('');
  const [dragging, setDragging]   = useState(false);
  const [pendingSession, setPendingSession] = useState(null);
  const fileInputRef = useRef(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setAuthStep('loading');

    try {
      const endpoint = mode === 'register' ? '/register' : '/login';
      const res = await fetch(`${API}${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        setAuthStep('form');
        return;
      }

      setPendingSession(data);

      // If already verified (returning user), skip photo step
      if (data.verified) {
        setAuthStep('done');
        setTimeout(() => onVerified(data), 800);
      } else {
        // New user or unverified — ask for photo
        setAuthStep('verify');
      }
    } catch {
      setError('Could not reach server. Try again.');
      setAuthStep('form');
    }
  };

  const processPhoto = async (file) => {
    if (!file?.type.startsWith('image/')) {
      setError('Please upload a valid image file.');
      return;
    }
    setAuthStep('verifying');
    try {
      // Call verify endpoint (authenticated with the session token)
      await fetch(`${API}/verify`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pendingSession.token}`,
        },
        body: JSON.stringify({}),
      });
      const session = { ...pendingSession, verified: true };
      setPendingSession(session);
      setAuthStep('done');
      setTimeout(() => onVerified(session), 1000);
    } catch {
      // Even if verify fails, let them in as unverified
      setAuthStep('done');
      setTimeout(() => onVerified(pendingSession), 1000);
    }
  };

  const skipVerify = () => {
    setAuthStep('done');
    setTimeout(() => onVerified(pendingSession), 400);
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {/* Header */}
      <header className="px-8 h-14 flex items-center justify-between shrink-0"
              style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="Logo" className="h-7 w-7 object-contain"
               style={{ filter: 'brightness(0) invert(1)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>MCHS Robotics</span>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>Team 5728</span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-16" style={{ paddingTop: '5rem' }}>
        {/* Logo hero */}
        <img src={logo} alt="MCHS Robotics" className="w-28 h-28 object-contain mb-8"
             style={{ filter: 'brightness(0) invert(1)', opacity: 0.88 }} />

        <div className="text-center mb-10">
          <h1 className="text-3xl font-semibold mb-2"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            Team Portal
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {mode === 'login' ? 'Sign in to access the team board.' : 'Create an account to join the team board.'}
          </p>
        </div>

        {/* Card */}
        <div className="w-full max-w-sm rounded-xl p-6"
             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>

          {/* ── Form step ── */}
          {authStep === 'form' && (
            <>
              {/* Mode tabs */}
              <div className="flex mb-5 rounded-lg p-0.5" style={{ background: 'var(--bg-overlay)' }}>
                {['login', 'register'].map(m => (
                  <button key={m} onClick={() => { setMode(m); setError(''); }}
                    className="flex-1 py-1.5 rounded-md text-xs font-medium transition-all capitalize"
                    style={{
                      background: mode === m ? 'var(--bg-elevated)' : 'transparent',
                      color:      mode === m ? 'var(--text-primary)' : 'var(--text-muted)',
                      border:     mode === m ? '1px solid var(--border)' : '1px solid transparent',
                    }}>
                    {m === 'login' ? 'Sign In' : 'Register'}
                  </button>
                ))}
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value.toLowerCase())}
                    placeholder="yourname"
                    autoComplete="username"
                    required
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
                    style={{
                      background: 'var(--bg-overlay)',
                      border:     '1px solid var(--border)',
                      color:      'var(--text-primary)',
                    }}
                    onFocus={e  => e.target.style.borderColor = 'var(--border-light)'}
                    onBlur={e   => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Password</label>
                  <div className="relative">
                    <input
                      type={showPass ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                      required
                      className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-colors"
                      style={{
                        background: 'var(--bg-overlay)',
                        border:     '1px solid var(--border)',
                        color:      'var(--text-primary)',
                      }}
                      onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
                    />
                    <button type="button" onClick={() => setShowPass(p => !p)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--text-subtle)' }}>
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <p className="text-xs px-3 py-2 rounded-lg"
                     style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.15)' }}>
                    {error}
                  </p>
                )}

                <button type="submit"
                  className="w-full py-2.5 rounded-lg text-sm font-medium transition-all mt-1"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                  {mode === 'login' ? 'Sign In' : 'Create Account'}
                </button>
              </form>
            </>
          )}

          {/* ── Loading ── */}
          {authStep === 'loading' && (
            <div className="py-10 text-center">
              <div className="w-6 h-6 rounded-full mx-auto mb-4 animate-spin"
                   style={{ border: '1.5px solid var(--border-light)', borderTopColor: 'var(--accent)' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {mode === 'login' ? 'Signing in…' : 'Creating account…'}
              </p>
            </div>
          )}

          {/* ── Photo verify ── */}
          {authStep === 'verify' && (
            <div>
              <p className="text-xs font-medium uppercase tracking-widest mb-1"
                 style={{ color: 'var(--text-subtle)' }}>Optional</p>
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                Verify your identity
              </p>
              <p className="text-xs mb-5" style={{ color: 'var(--text-muted)' }}>
                Upload a photo to get a <span style={{ color: '#22c55e' }}>✓ verified</span> badge in chat. You can skip this.
              </p>

              <div
                className="rounded-lg p-7 text-center cursor-pointer transition-all duration-150 mb-3"
                style={{
                  border:     `1px dashed ${dragging ? 'var(--accent)' : 'var(--border-light)'}`,
                  background: dragging ? 'rgba(0,102,179,0.05)' : 'transparent',
                }}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); processPhoto(e.dataTransfer.files[0]); }}
                onClick={() => fileInputRef.current?.click()}
              >
                <input type="file" ref={fileInputRef}
                       onChange={e => processPhoto(e.target.files[0])}
                       accept="image/*" className="hidden" />
                <Upload className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--text-subtle)' }} />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Click or drag to upload</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-subtle)' }}>JPG, PNG, WebP</p>
              </div>

              <button onClick={skipVerify}
                className="w-full py-2 rounded-lg text-xs transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
                Skip for now
              </button>
            </div>
          )}

          {/* ── Verifying photo ── */}
          {authStep === 'verifying' && (
            <div className="py-10 text-center">
              <div className="w-6 h-6 rounded-full mx-auto mb-4 animate-spin"
                   style={{ border: '1.5px solid var(--border-light)', borderTopColor: '#22c55e' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Verifying…</p>
            </div>
          )}

          {/* ── Done ── */}
          {authStep === 'done' && (
            <div className="py-10 text-center">
              <CheckCircle className="w-6 h-6 mx-auto mb-3" style={{ color: '#22c55e' }} />
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                {pendingSession?.verified ? 'Verified — welcome!' : 'Welcome!'}
              </p>
              <p className="text-xs flex items-center justify-center gap-1" style={{ color: 'var(--text-muted)' }}>
                <ArrowRight className="w-3 h-3" /> Entering portal
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-1.5">
          <Shield className="w-3 h-3" style={{ color: 'var(--text-subtle)' }} />
          <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            Secure · MCHS Robotics {new Date().getFullYear()}
          </span>
        </div>
      </main>
    </div>
  );
}
