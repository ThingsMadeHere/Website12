import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, X, Inbox, Clock, UserCheck, UserX } from 'lucide-react';

// SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC
const parseTs = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);

const STATUS_META = {
  pending:  { label: 'Pending',  color: '#a16207', bg: 'rgba(255,199,44,0.1)',  border: 'rgba(255,199,44,0.25)' },
  approved: { label: 'Approved', color: '#166534', bg: 'rgba(34,197,94,0.1)',    border: 'rgba(34,197,94,0.25)' },
  denied:   { label: 'Denied',   color: '#dc2626', bg: 'rgba(239,68,68,0.1)',    border: 'rgba(239,68,68,0.25)' },
};

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full shrink-0"
          style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
      {meta.label}
    </span>
  );
}

export default function ApplicationsPage({ session }) {
  const [applications, setApplications] = useState([]);
  const [filter, setFilter]       = useState('pending'); // pending | all
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [busyId, setBusyId]       = useState(null);
  const [photos, setPhotos]       = useState({}); // id → object URL
  const photosRef = useRef({});

  const api = useCallback((path, opts = {}) => fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${session.token}`,
    },
  }), [session.token]);

  // Load applications
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api(filter === 'pending' ? '/api/applications?status=pending' : '/api/applications?status=all');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not load applications');
        setApplications([]);
        return;
      }
      const list = await res.json();
      setApplications(list);

      // Fetch photos for any rows we don't have yet (admin-authed → blob URLs)
      for (const a of list) {
        if (a.hasPhoto && !photosRef.current[a.id]) {
          try {
            const pres = await api(`/api/applications/${a.id}/photo`);
            if (pres.ok) {
              const url = URL.createObjectURL(await pres.blob());
              photosRef.current[a.id] = url;
              setPhotos(p => ({ ...p, [a.id]: url }));
            }
          } catch { /* photo optional */ }
        }
      }
    } catch {
      setError('Could not reach server');
    } finally {
      setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => { load(); }, [load]);

  // Revoke blob URLs on unmount
  useEffect(() => () => {
    Object.values(photosRef.current).forEach(u => URL.revokeObjectURL(u));
  }, []);

  const decide = async (a, action) => {
    const verb = action === 'approve' ? 'Approve' : 'Deny';
    const extra = action === 'approve'
      ? '\n\nTheir account will be created (with the ✓ verified badge) and they can sign in right away.'
      : '\n\nThey will be told their application was not approved if they try to sign in.';
    if (!window.confirm(`${verb} ${a.fullName} (@${a.username})?${extra}`)) return;

    setBusyId(a.id);
    try {
      const res = await api(`/api/applications/${a.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || `Could not ${action} application`);
      } else {
        setApplications(prev => prev.map(x =>
          x.id === a.id
            ? { ...x, status: action === 'approve' ? 'approved' : 'denied', decidedAt: new Date().toISOString() }
            : x
        ));
      }
    } catch {
      alert('Could not reach server');
    }
    setBusyId(null);
  };

  const fmtDate = (s) => {
    const d = parseTs(s);
    return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : s;
  };

  const pendingCount = applications.filter(a => a.status === 'pending').length;

  return (
    <div className="min-h-screen py-8 sm:py-16 px-3 sm:px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-6 sm:mb-10">
          <p className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
            Admin
          </p>
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold mb-1"
                  style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                Membership Applications
              </h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Review applicant photos and details. Approving creates their account.
              </p>
            </div>
            {/* Filter tabs */}
            <div className="flex rounded-lg p-0.5 shrink-0" style={{ background: 'var(--bg-overlay)' }}>
              {[
                { id: 'pending', label: `Pending${pendingCount && filter === 'all' ? ` (${pendingCount})` : ''}` },
                { id: 'all', label: 'All' },
              ].map(t => (
                <button key={t.id} onClick={() => setFilter(t.id)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                  style={{
                    background: filter === t.id ? 'var(--bg-elevated)' : 'transparent',
                    color:      filter === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
                    border:     filter === t.id ? '1px solid var(--border)' : '1px solid transparent',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <p className="text-sm px-4 py-3 rounded-lg mb-4"
             style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.15)' }}>
            {error}
          </p>
        )}

        {loading && (
          <div className="py-16 text-center">
            <div className="w-6 h-6 rounded-full mx-auto mb-4 animate-spin"
                 style={{ border: '1.5px solid var(--border-light)', borderTopColor: 'var(--accent)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading applications…</p>
          </div>
        )}

        {!loading && applications.length === 0 && (
          <div className="py-16 text-center rounded-xl"
               style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
            <Inbox className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--text-subtle)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {filter === 'pending' ? 'No pending applications 🎉' : 'No applications yet.'}
            </p>
          </div>
        )}

        {/* Application cards */}
        <div className="space-y-3">
          {!loading && applications.map(a => (
            <div key={a.id} className="rounded-xl p-4 sm:p-5"
                 style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
              <div className="flex flex-col sm:flex-row gap-4">
                {/* Photo */}
                <div className="shrink-0 mx-auto sm:mx-0">
                  {photos[a.id] ? (
                    <img src={photos[a.id]} alt={`Photo of ${a.fullName}`}
                         className="w-24 h-24 sm:w-20 sm:h-20 rounded-lg object-cover"
                         style={{ border: '1px solid var(--border)' }} />
                  ) : (
                    <div className="w-24 h-24 sm:w-20 sm:h-20 rounded-lg flex items-center justify-center"
                         style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-subtle)' }}>
                      {a.hasPhoto ? <Clock className="w-4 h-4 animate-pulse" /> : <UserX className="w-4 h-4" />}
                    </div>
                  )}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0 text-center sm:text-left">
                  <div className="flex items-center justify-center sm:justify-start gap-2 flex-wrap mb-1">
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {a.fullName}
                    </h3>
                    <StatusPill status={a.status} />
                  </div>
                  <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    @{a.username}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                    Applied {fmtDate(a.createdAt)}
                    {a.decidedAt && ` · decided ${fmtDate(a.decidedAt)}`}
                  </p>
                </div>

                {/* Actions */}
                {a.status === 'pending' && (
                  <div className="flex gap-2 shrink-0 sm:items-start">
                    <button onClick={() => decide(a, 'approve')} disabled={busyId === a.id}
                      className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'rgba(34,197,94,0.12)', color: '#166534', border: '1px solid rgba(34,197,94,0.3)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(34,197,94,0.2)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(34,197,94,0.12)'}>
                      <Check className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button onClick={() => decide(a, 'deny')} disabled={busyId === a.id}
                      className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.25)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.18)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.1)'}>
                      <X className="w-3.5 h-3.5" /> Deny
                    </button>
                  </div>
                )}
                {a.status === 'approved' && (
                  <div className="hidden sm:flex items-center gap-1.5 text-xs shrink-0" style={{ color: '#166534' }}>
                    <UserCheck className="w-3.5 h-3.5" /> account created
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-8 text-xs text-center" style={{ color: 'var(--text-subtle)' }}>
          Applicants are told their application is pending when they try to sign in.
          Approved members get the ✓ verified badge automatically.
        </p>
      </div>
    </div>
  );
}
