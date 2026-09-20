import { useState, useEffect, useCallback, useRef } from 'react';
import LandingPage from './components/LandingPage';
import MessageBoard from './components/MessageBoard';
import FAQ from './components/FAQ';
import HomePage from './components/HomePage';
import CalendarPage from './components/CalendarPage';
import ApplicationsPage from './components/ApplicationsPage';
import AdminPage from './components/AdminPage';
import RemoteDevPage from './components/RemoteDevPage';
import ProfilePage from './components/ProfilePage';
import { MessageSquare, HelpCircle, Home, Calendar, LogIn, LogOut, ClipboardCheck, ShieldCheck, Terminal, User } from 'lucide-react';
import logo from './assets/output-onlinepngtools.png';
import { initializePushNotifications } from './utils/pushNotifications';

const SESSION_KEY = 'mchs_session';

function Navigation({ currentView, setCurrentView, session, onLogout }) {
  return (
    <nav style={{ borderBottom: '1px solid #0e3a20', background: '#14532d' }}
         className="px-3 sm:px-6 h-12 flex items-center justify-between gap-2">
      <button onClick={() => setCurrentView('home')} className="flex items-center gap-2 sm:gap-2.5 shrink-0 min-w-0">
        <img src={logo} alt="MCHS Robotics" className="h-7 w-7 object-contain shrink-0"
             style={{ filter: 'brightness(0) invert(1)' }} />
        <span className="text-sm font-semibold truncate hidden sm:inline" style={{ color: '#ffffff' }}>
          MCHS Robotics
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded hidden sm:inline font-semibold"
              style={{ background: 'rgba(255,199,44,0.16)', color: '#ffd75e', border: '1px solid rgba(255,199,44,0.45)' }}>
          5728
        </span>
      </button>

      <div className="flex items-center gap-0.5 sm:gap-1">
        {[
          { view: 'home',   icon: Home,          label: 'Home'   },
          { view: 'chat',   icon: MessageSquare, label: 'Board'  },
          { view: 'faq',    icon: HelpCircle,    label: 'FAQ'    },
          { view: 'calendar', icon: Calendar,    label: 'Calendar' },
          { view: 'remote-dev', icon: Terminal,  label: 'Remote Dev' },
          ...(session?.admin
            ? [
                { view: 'applications', icon: ClipboardCheck, label: 'Applications' },
                { view: 'admin',        icon: ShieldCheck,    label: 'Admin' },
              ]
            : []),
        ].map(({ view, icon: Icon, label }) => {
          const active = currentView === view;
          return (
            <button key={view} onClick={() => setCurrentView(view)} title={label}
              className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded text-xs transition-colors duration-150"
              style={{
                color:      active ? '#ffffff' : '#b9cdb2',
                background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                border:     active ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
              }}>
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          );
        })}

        {/* Profile button for signed-in users */}
        {session && (
          <button onClick={() => setCurrentView('profile')} title="Profile"
            className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded text-xs transition-colors duration-150 ${currentView === 'profile' ? 'active' : ''}`}
            style={{
              color:      currentView === 'profile' ? '#ffffff' : '#b9cdb2',
              background: currentView === 'profile' ? 'rgba(255,255,255,0.12)' : 'transparent',
              border:     currentView === 'profile' ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
            }}>
            <User className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Profile</span>
          </button>
        )}

        {/* Signed out — sign-in button (gold on the green bar) */}
        {!session && (
          <button onClick={() => setCurrentView('chat')}
            className="flex items-center gap-1.5 ml-1 sm:ml-2 pl-2 sm:pl-2 px-2 sm:px-2.5 py-1.5 rounded text-xs font-semibold transition-colors"
            style={{ borderLeft: '1px solid rgba(255,255,255,0.25)', color: '#14532d', background: '#ffc72c' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#ffd75e'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#ffc72c'; }}>
            <LogIn className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Sign in</span>
          </button>
        )}

        {/* User pill */}
        {session && (
          <div className="flex items-center gap-1.5 ml-1 sm:ml-2 pl-2"
               style={{ borderLeft: '1px solid rgba(255,255,255,0.25)' }}>
            <span className="text-xs hidden sm:inline" style={{ color: '#d9e5d3' }}>
              {session.username}
            </span>
            {session.verified && (
              <span className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(134,239,172,0.16)', color: '#86efac', border: '1px solid rgba(134,239,172,0.35)' }}>
                ✓
              </span>
            )}
            {session.admin && (
              <span className="text-xs px-1.5 py-0.5 rounded hidden sm:inline"
                    style={{ background: 'rgba(255,199,44,0.16)', color: '#ffd75e', border: '1px solid rgba(255,199,44,0.45)' }}>
                admin
              </span>
            )}
            <button onClick={onLogout} title="Sign out"
              className="text-xs px-2 py-1 rounded transition-colors ml-0.5 sm:ml-1 flex items-center gap-1.5"
              style={{ color: '#b9cdb2', border: '1px solid rgba(255,255,255,0.22)' }}
              onMouseEnter={e => { e.currentTarget.style.color = '#fecaca'; e.currentTarget.style.borderColor = 'rgba(254,202,202,0.45)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#b9cdb2'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)'; }}>
              <LogOut className="w-3.5 h-3.5 sm:hidden" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

export default function App() {
  const [currentView, setCurrentView] = useState('home');

  // Initialize session from localStorage if available
  let initialSession = null;
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Validate session has required fields
      if (parsed.userId && parsed.token) {
        initialSession = parsed;
      }
    }
  } catch { /* ignore */ }

  const [session, setSession] = useState(initialSession);

  // Always-fresh session for callbacks (avoids stale closures in timers)
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Pull the latest account state (admin flag, tags, verified badge, timeout)
  // from the server so changes made in the Admin panel apply without a re-login.
  const refreshSession = useCallback(async () => {
    const s = sessionRef.current;
    if (!s?.token) return;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${s.token}` } });
      if (res.status === 401) {
        // Session was invalidated (signed out elsewhere, purged by an admin, …)
        setSession(null);
        localStorage.removeItem(SESSION_KEY);
        setCurrentView(v => (v === 'chat' || v === 'admin' || v === 'applications' ? 'home' : v));
        return;
      }
      if (!res.ok) return;
      const me = await res.json();
      setSession(prev => {
        if (!prev) return prev;
        const merged = { ...prev, ...me };
        localStorage.setItem(SESSION_KEY, JSON.stringify(merged));
        return merged;
      });
    } catch { /* offline — keep the current session */ }
  }, []);

  useEffect(() => {
    if (!session?.token) return undefined;
    refreshSession();
    const t = setInterval(refreshSession, 60000);
    
    // Initialize push notifications when user logs in
    initializePushNotifications(session.token).catch(err => {
      console.warn('Failed to initialize push notifications:', err);
    });
    
    return () => clearInterval(t);
  }, [session?.token, refreshSession]);

  const handleVerified = (sessionData) => {
    setSession(sessionData);
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    // They signed in to use the board — take them straight there.
    setCurrentView('chat');
  };

  const handleLogout = () => {
    // Invalidate the session token on the server (fire-and-forget)
    if (session?.token) {
      fetch('/api/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      }).catch(() => {});
    }
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
    // Don't leave #chat in the URL — the board is members-only.
    if (window.location.hash === '#chat') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setCurrentView('home');
  };

  const handleBackToSite = () => {
    if (window.location.hash === '#chat') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setCurrentView('home');
  };

  // Handle hash changes for navigation
  const isAdmin = !!session?.admin;
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash === 'faq' || hash === 'calendar') {
        setCurrentView(hash);
      } else if (hash === 'chat') {
        setCurrentView('chat');
      } else if (hash === 'remote-dev' && session) {
        setCurrentView('remote-dev');
      } else if (hash === 'profile' && session) {
        setCurrentView('profile');
      } else if (hash === 'applications' && isAdmin) {
        setCurrentView('applications');
      } else if (hash === 'admin' && isAdmin) {
        setCurrentView('admin');
      } else {
        setCurrentView('home');
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    handleHashChange(); // Initial check

    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [isAdmin, session]);

  // If the signed-in member loses admin (tag removed in the Admin panel),
  // don't leave them staring at an admin-only page.
  useEffect(() => {
    if (session && !session.admin && (currentView === 'admin' || currentView === 'applications')) {
      setCurrentView('home');
    }
  }, [session, currentView]);

  // The board is members-only: signed-out visitors get the sign-in screen
  // instead. Everything else (home / FAQ / calendar) stays public.
  if (!session && currentView === 'chat') {
    return <LandingPage onVerified={handleVerified} onBack={handleBackToSite} />;
  }

  // Remote dev is also members-only
  if (!session && currentView === 'remote-dev') {
    return <LandingPage onVerified={handleVerified} onBack={handleBackToSite} />;
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <Navigation
        currentView={currentView}
        setCurrentView={setCurrentView}
        session={session}
        onLogout={handleLogout}
      />
      {currentView === 'home' && <HomePage />}
      {currentView === 'chat' && session && <MessageBoard session={session} refreshSession={refreshSession} />}
      {currentView === 'faq'  && <FAQ setCurrentView={setCurrentView} />}
      {currentView === 'calendar' && <CalendarPage session={session} setCurrentView={setCurrentView} />}
      {currentView === 'remote-dev' && session && <RemoteDevPage session={session} />}
      {currentView === 'profile' && session && <ProfilePage session={session} setCurrentView={setCurrentView} />}
      {currentView === 'applications' && session?.admin && <ApplicationsPage session={session} />}
      {currentView === 'admin' && session?.admin && <AdminPage session={session} />}
    </div>
  );
}
