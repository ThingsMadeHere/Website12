import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, ArrowRight, RefreshCw } from 'lucide-react';

export default function MagicLinkVerify() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'error'
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    
    if (!token) {
      setStatus('error');
      setError('No verification token found. Please request a new magic link.');
      return;
    }

    // Verify token with server
    fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Invalid or expired verification link');
        }
        return res.json();
      })
      .then((data) => {
        // Save session
        localStorage.setItem('mchs_session', JSON.stringify({
          userId: data.userId,
          token: data.token,
          username: data.username,
          verified: data.verified,
          admin: data.admin,
          fullName: data.fullName,
          tags: data.tags,
        }));
        
        setStatus('success');
      })
      .catch((err) => {
        console.error('Magic link verification failed:', err);
        setStatus('error');
        setError(err.message || 'Failed to verify magic link. Please try again.');
      });
  }, []);

  useEffect(() => {
    if (status !== 'success') return;
    
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          window.location.hash = 'chat';
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    return () => clearInterval(timer);
  }, [status]);

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="w-12 h-12 rounded-full animate-spin border-4 border-t-transparent"
             style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
        <p className="mt-4 text-sm" style={{ color: 'var(--text-muted)' }}>Verifying your magic link...</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ background: 'var(--bg-base)' }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
             style={{ background: 'rgba(248,113,113,0.12)' }}>
          <RefreshCw className="w-8 h-8" style={{ color: '#b91c1c' }} />
        </div>
        <h1 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Verification Failed</h1>
        <p className="text-sm max-w-sm text-center mb-6" style={{ color: 'var(--text-muted)' }}>
          {error}
        </p>
        <a href="#chat" className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
           style={{ background: 'var(--accent)', color: '#ffffff' }}
           onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
           onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
          <ArrowRight className="w-4 h-4" />
          Go to Sign In
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ background: 'var(--bg-base)' }}>
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
           style={{ background: 'rgba(16,185,129,0.12)' }}>
        <CheckCircle className="w-8 h-8" style={{ color: '#10b981' }} />
      </div>
      <h1 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Verified!</h1>
      <p className="text-sm max-w-sm text-center mb-6" style={{ color: 'var(--text-muted)' }}>
        Your magic link is valid. Redirecting to the board...
      </p>
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        Redirecting in {countdown} second{countdown !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
