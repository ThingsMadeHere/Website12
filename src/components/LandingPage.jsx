import { useState, useRef } from 'react';
import { Upload, CheckCircle, ArrowRight, ArrowLeft, Shield, Eye, EyeOff, X, KeyRound } from 'lucide-react';
import logo from '../assets/output-onlinepngtools.png';
import { compressPhoto, MAX_FILE_BYTES } from '../utils/photo';

const API = '/api';

export default function LandingPage({ onVerified, onBack }) {
  const [mode, setMode]           = useState('login'); // 'login' | 'apply'
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [fullName, setFullName]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [authStep, setAuthStep]   = useState('form'); // 'form' | 'loading' | 'done' | 'applied' | 'reset'
  const [error, setError]         = useState('');
  const [dragging, setDragging]   = useState(false);

  // forced password reset (admin required a change at this login)
  const [newPass, setNewPass]         = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [resetting, setResetting]     = useState(false);

  // application photo state
  const [photo, setPhoto]         = useState(null); // { mime, data }
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoName, setPhotoName] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);

  const fileInputRef = useRef(null);

  const resetForm = () => {
    setError('');
    setPassword('');
  };

  const handlePhoto = async (file) => {
    if (!file) return;
    setError('');
    if (!file.type.startsWith('image/')) {
      setError('Please choose a valid image file (JPG, PNG, WebP, or GIF).');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That photo is too large — please pick one under 6 MB.');
      return;
    }
    setPhotoBusy(true);
    try {
      const compressed = await compressPhoto(file);
      setPhoto({ mime: compressed.mime, data: compressed.data });
      setPhotoPreview(compressed.preview);
      setPhotoName(file.name);
    } catch (err) {
      setError(err.message || 'Could not process that photo. Try another file.');
    }
    setPhotoBusy(false);
  };

  const clearPhoto = () => {
    setPhoto(null);
    setPhotoPreview(null);
    setPhotoName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── sign in ────────────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setAuthStep('loading');
    try {
      const res = await fetch(`${API}/login`, {
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
      // An admin requires a password change before this account can sign in.
      if (data.mustChangePassword) {
        setNewPass('');
        setConfirmPass('');
        setAuthStep('reset');
        return;
      }
      setAuthStep('done');
      setTimeout(() => onVerified(data), 700);
    } catch {
      setError('Could not reach server. Try again.');
      setAuthStep('form');
    }
  };

  // ── forced password change (admin-flagged accounts) ───────────────────────
  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    if (newPass.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (newPass !== confirmPass) { setError('The two passwords do not match.'); return; }
    if (newPass === password) { setError('Your new password must be different from the current one.'); return; }
    setResetting(true);
    setAuthStep('loading');
    try {
      const res = await fetch(`${API}/password/reset`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, currentPassword: password, newPassword: newPass }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not change password');
        setResetting(false);
        setAuthStep('reset');
        return;
      }
      setAuthStep('done');
      setTimeout(() => onVerified(data), 700);
    } catch {
      setError('Could not reach server. Try again.');
      setResetting(false);
      setAuthStep('reset');
    }
  };

  // ── apply to join ──────────────────────────────────────────────────────────
  const handleApply = async (e) => {
    e.preventDefault();
    setError('');

    if (!fullName.trim())  { setError('Please enter your full name.'); return; }
    if (!username.trim())  { setError('Please choose a username.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (!photo)            { setError('Please attach a photo of yourself — it is required for review.'); return; }

    setAuthStep('loading');
    try {
      const res = await fetch(`${API}/applications`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, fullName: fullName.trim(), photo }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not submit your application');
        setAuthStep('form');
        return;
      }
      setAuthStep('applied');
    } catch {
      setError('Could not reach server. Try again.');
      setAuthStep('form');
    }
  };

  const headline = authStep === 'applied'
    ? 'Application received'
    : authStep === 'reset'
      ? 'Choose a new password'
      : mode === 'login'
        ? 'Team Portal'
        : 'Join the Team';
  const subline = authStep === 'applied'
    ? 'A team admin will review it shortly.'
    : authStep === 'reset'
      ? 'An admin requires you to pick a new password before signing in.'
      : mode === 'login'
        ? 'Sign in to access the team board.'
        : 'Apply with your name and a photo — an admin reviews every application.';

  const inputStyle = {
    background: 'var(--bg-overlay)',
    border:     '1px solid var(--border)',
    color:      'var(--text-primary)',
  };

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
          <img src={logo} alt="Logo" className="h-7 w-7 object-contain"
               style={{ filter: 'brightness(0)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>MCHS Robotics</span>
        </div>
        <span className="text-xs hidden sm:inline" style={{ color: 'var(--gold)' }}>Team 5728</span>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pb-10 sm:pb-16"
            style={{ paddingTop: 'clamp(2rem, 6vh, 5rem)' }}>
        {/* Logo hero */}
        <img src={logo} alt="MCHS Robotics" className="w-20 h-20 sm:w-28 sm:h-28 object-contain mb-6 sm:mb-8"
             style={{ filter: 'brightness(0)', opacity: 0.92 }} />

        <div className="text-center mb-8 sm:mb-10 px-4">
          <h1 className="text-2xl sm:text-3xl font-semibold mb-2"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            {headline}
          </h1>
          <p className="text-sm max-w-sm mx-auto" style={{ color: 'var(--text-muted)' }}>
            {subline}
          </p>
        </div>

        {/* Card */}
        <div className="w-full max-w-sm rounded-xl p-5 sm:p-6"
             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(29,36,25,0.08)' }}>

          {/* ── Forced password reset ── */}
          {authStep === 'reset' && (
            <form onSubmit={handleResetPassword} className="space-y-3">
              <div className="rounded-lg p-3 flex items-start gap-2.5 mb-1"
                   style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                <KeyRound className="w-4 h-4 mt-0.5 shrink-0" style={{ color: '#b45309' }} />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Signing in as <strong style={{ color: 'var(--text-primary)' }}>@{username}</strong>.
                  A team admin flagged this account for a password change — pick a new password to continue.
                </p>
              </div>

              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>New password</label>
                <input
                  type={showPass ? 'text' : 'password'}
                  value={newPass}
                  onChange={e => setNewPass(e.target.value)}
                  placeholder="at least 6 characters"
                  autoComplete="new-password"
                  required
                  minLength={6}
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                  onBlur={e  => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Confirm new password</label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={confirmPass}
                    onChange={e => setConfirmPass(e.target.value)}
                    placeholder="type it again"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-colors"
                    style={inputStyle}
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
                   style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.15)' }}>
                  {error}
                </p>
              )}

              <button type="submit"
                className="w-full py-2.5 rounded-lg text-sm font-medium transition-all mt-1"
                style={{ background: 'var(--accent)', color: '#fff' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                Change password &amp; sign in
              </button>

              <button type="button"
                onClick={() => { setAuthStep('form'); setMode('login'); setError(''); setPassword(''); setNewPass(''); setConfirmPass(''); }}
                className="w-full py-2 rounded-lg text-xs transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
                Back to sign in
              </button>
            </form>
          )}

          {/* ── Form step ── */}
          {authStep === 'form' && (
            <>
              {/* Mode tabs */}
              <div className="flex mb-5 rounded-lg p-0.5" style={{ background: 'var(--bg-overlay)' }}>
                {[
                  { id: 'login', label: 'Sign In' },
                  { id: 'apply', label: 'Apply to Join' },
                ].map(m => (
                  <button key={m.id} onClick={() => { setMode(m.id); resetForm(); }}
                    className="flex-1 py-1.5 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: mode === m.id ? 'var(--bg-elevated)' : 'transparent',
                      color:      mode === m.id ? 'var(--text-primary)' : 'var(--text-muted)',
                      border:     mode === m.id ? '1px solid var(--border)' : '1px solid transparent',
                    }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {/* ── Sign-in form ── */}
              {mode === 'login' && (
                <form onSubmit={handleLogin} className="space-y-3">
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
                      style={inputStyle}
                      onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
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
                        autoComplete="current-password"
                        required
                        className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-colors"
                        style={inputStyle}
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
                       style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.15)' }}>
                      {error}
                    </p>
                  )}

                  <button type="submit"
                    className="w-full py-2.5 rounded-lg text-sm font-medium transition-all mt-1"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                    Sign In
                  </button>

                  <p className="text-xs text-center pt-1" style={{ color: 'var(--text-subtle)' }}>
                    No account yet?{' '}
                    <button type="button" onClick={() => { setMode('apply'); resetForm(); }}
                      className="underline transition-colors"
                      style={{ color: 'var(--text-muted)' }}>
                      Apply to join
                    </button>
                  </p>
                </form>
              )}

              {/* ── Application form ── */}
              {mode === 'apply' && (
                <form onSubmit={handleApply} className="space-y-3">
                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Full name</label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={e => setFullName(e.target.value)}
                      placeholder="Alex Nguyen"
                      autoComplete="name"
                      required
                      maxLength={80}
                      className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
                      style={inputStyle}
                      onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
                    />
                  </div>

                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      Username <span style={{ color: 'var(--text-subtle)' }}>· you'll sign in with this</span>
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value.toLowerCase())}
                      placeholder="yourname"
                      autoComplete="username"
                      required
                      className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
                      style={inputStyle}
                      onFocus={e => e.target.style.borderColor = 'var(--border-light)'}
                      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
                    />
                  </div>

                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Password</label>
                    <div className="relative">
                      <input
                        type={showPass ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="at least 6 characters"
                        autoComplete="new-password"
                        required
                        minLength={6}
                        className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-colors"
                        style={inputStyle}
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

                  {/* Photo (required) */}
                  <div>
                    <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      Photo of you <span style={{ color: '#dc2626' }}>*</span>{' '}
                      <span style={{ color: 'var(--text-subtle)' }}>· reviewed by an admin</span>
                    </label>

                    {photoBusy && (
                      <div className="rounded-lg p-5 text-center"
                           style={{ border: '1px dashed var(--border-light)' }}>
                        <div className="w-5 h-5 rounded-full mx-auto mb-2 animate-spin"
                             style={{ border: '1.5px solid var(--border-light)', borderTopColor: 'var(--accent)' }} />
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Processing photo…</p>
                      </div>
                    )}

                    {!photoBusy && !photo && (
                      <div
                        className="rounded-lg p-5 text-center cursor-pointer transition-all duration-150"
                        style={{
                          border:     `1px dashed ${dragging ? 'var(--accent)' : 'var(--border-light)'}`,
                          background: dragging ? 'rgba(22,163,74,0.05)' : 'transparent',
                        }}
                        onDragOver={e => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={e => { e.preventDefault(); setDragging(false); handlePhoto(e.dataTransfer.files[0]); }}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <input type="file" ref={fileInputRef}
                               onChange={e => handlePhoto(e.target.files[0])}
                               accept="image/*" className="hidden" />
                        <Upload className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--text-subtle)' }} />
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Click or drag to upload</p>
                        <p className="text-xs mt-1" style={{ color: 'var(--text-subtle)' }}>JPG, PNG, WebP, GIF</p>
                      </div>
                    )}

                    {!photoBusy && photo && (
                      <div className="rounded-lg p-3 flex items-center gap-3"
                           style={{ border: '1px solid var(--border)', background: 'var(--bg-overlay)' }}>
                        <img src={photoPreview} alt="Your photo"
                             className="w-12 h-12 rounded-md object-cover shrink-0"
                             style={{ border: '1px solid var(--border)' }} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{photoName}</p>
                          <p className="text-xs" style={{ color: '#166534' }}>Ready to submit</p>
                        </div>
                        <button type="button" onClick={clearPhoto} title="Remove photo"
                          className="p-1.5 rounded transition-colors shrink-0"
                          style={{ color: 'var(--text-subtle)', border: '1px solid var(--border)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {error && (
                    <p className="text-xs px-3 py-2 rounded-lg"
                       style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.15)' }}>
                      {error}
                    </p>
                  )}

                  <button type="submit" disabled={photoBusy}
                    className="w-full py-2.5 rounded-lg text-sm font-medium transition-all mt-1 disabled:opacity-50"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
                    Submit Application
                  </button>

                  <p className="text-xs text-center pt-1" style={{ color: 'var(--text-subtle)' }}>
                    Already have an account?{' '}
                    <button type="button" onClick={() => { setMode('login'); resetForm(); }}
                      className="underline transition-colors"
                      style={{ color: 'var(--text-muted)' }}>
                      Sign in
                    </button>
                  </p>
                </form>
              )}
            </>
          )}

          {/* ── Loading ── */}
          {authStep === 'loading' && (
            <div className="py-10 text-center">
              <div className="w-6 h-6 rounded-full mx-auto mb-4 animate-spin"
                   style={{ border: '1.5px solid var(--border-light)', borderTopColor: 'var(--accent)' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {resetting ? 'Changing your password…' : mode === 'login' ? 'Signing in…' : 'Submitting your application…'}
              </p>
            </div>
          )}

          {/* ── Application received ── */}
          {authStep === 'applied' && (
            <div className="py-6 text-center">
              <CheckCircle className="w-8 h-8 mx-auto mb-3" style={{ color: '#166534' }} />
              <p className="text-sm font-medium mb-2 leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                Thank you for the application, it will be processed shortly.
              </p>
              <p className="text-xs leading-relaxed mb-5" style={{ color: 'var(--text-muted)' }}>
                A team admin will review your name and photo. Once you're approved, come back
                and sign in with the username and password you just chose.
              </p>
              <div className="space-y-2">
                <button onClick={() => { setMode('login'); setAuthStep('form'); resetForm(); }}
                  className="w-full py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--accent)', color: '#fff' }}>
                  I have an account — Sign in
                </button>
                {onBack && (
                  <button onClick={onBack}
                    className="w-full py-2 rounded-lg text-xs transition-colors"
                    style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                    onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
                    Back to site
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Signed in ── */}
          {authStep === 'done' && (
            <div className="py-10 text-center">
              <CheckCircle className="w-6 h-6 mx-auto mb-3" style={{ color: '#166534' }} />
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                Welcome back!
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
