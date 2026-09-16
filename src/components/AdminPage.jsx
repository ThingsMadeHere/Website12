import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, RefreshCw, UserPlus, ChevronDown, Save, Camera, X, Check,
  Ban, TimerOff, KeyRound, RotateCcw, ShieldCheck, Clock, BadgeCheck,
  Lock, Unlock, Upload, Users, AlertTriangle,
} from 'lucide-react';
import TagPill from './TagPill';
import { SUGGESTED_TAGS } from '../utils/tags';
import { compressPhoto, MAX_FILE_BYTES } from '../utils/photo';

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) — used for createdAt / lastSeen
const parseTs = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
// timeoutUntil arrives as ISO-8601
const parseIso = (s) => (s ? new Date(s) : null);

const fmtDateTime = (d) => (d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

function fmtRemaining(ms) {
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

const TIMEOUT_PRESETS = [
  { label: '10 min', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '1 day', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
  { label: '1 week', minutes: 10080 },
];

function genTempPassword() {
  // 12 chars, unambiguous alphabet — meant to be shared then replaced.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(alphabet.length * 12));
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const inputStyle = {
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
};

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}

// Small avatar: member photo when available, else a colored initial.
function Avatar({ user, photos, size = 'w-10 h-10 text-sm' }) {
  const src = photos[user.id];
  if (src)
    return <img src={src} alt={user.username} className={`${size.split(' ').slice(0, 2).join(' ')} rounded-lg object-cover shrink-0`}
                style={{ border: '1px solid var(--border)' }} />;
  const colors = ['#15803d', '#a67c00', '#4d7c0f', '#0f766e', '#92400e', '#3f6212'];
  let h = 0;
  const name = user.username || '?';
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return (
    <div className={`${size} rounded-lg flex items-center justify-center font-semibold text-white select-none shrink-0`}
         style={{ background: colors[Math.abs(h) % colors.length] }}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ── photo picker used by both the editor and the create form ────────────────
function PhotoPicker({ preview, busy, onFile, onClear, clearLabel = 'Remove photo' }) {
  const fileRef = useRef(null);
  return (
    <div className="flex items-center gap-3">
      {preview ? (
        <img src={preview} alt="Profile preview" className="w-16 h-16 rounded-lg object-cover shrink-0"
             style={{ border: '1px solid var(--border)' }} />
      ) : (
        <div className="w-16 h-16 rounded-lg flex items-center justify-center shrink-0"
             style={{ background: 'var(--bg-base)', border: '1px dashed var(--border-light)', color: 'var(--text-subtle)' }}>
          <Camera className="w-4 h-4" />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <button type="button" disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-light)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
          <Upload className="w-3.5 h-3.5" /> {busy ? 'Processing…' : 'Upload photo'}
        </button>
        {preview && onClear && (
          <button type="button" onClick={onClear}
            className="px-3 py-1 rounded-lg text-xs transition-colors text-left"
            style={{ color: 'var(--text-subtle)' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; }}>
            {clearLabel}
          </button>
        )}
        <input type="file" ref={fileRef} accept="image/*" className="hidden"
               onChange={e => { onFile(e.target.files[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
}

// ── expandable per-member editor ─────────────────────────────────────────────
function MemberCard({ user, isSelf, photos, expanded, onToggle, api, onUpdated, onError, onToast, now }) {
  const [fullName, setFullName]   = useState(user.fullName || '');
  const [username, setUsername]   = useState(user.username || '');
  const [verified, setVerified]   = useState(!!user.verified);
  const [photoPick, setPhotoPick] = useState(null); // { mime, data, preview }
  const [photoRemove, setPhotoRemove] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [tagInput, setTagInput]   = useState('');
  const [customUntil, setCustomUntil] = useState('');
  const [busy, setBusy]           = useState('');

  const photoPreview = photoRemove
    ? null
    : (photoPick ? photoPick.preview : (photos[user.id] || null));

  const dirty =
    fullName !== (user.fullName || '') ||
    username !== user.username ||
    verified !== !!user.verified ||
    !!photoPick || photoRemove;

  const timeoutUntil = parseIso(user.timeoutUntil);
  const timedOut = timeoutUntil && timeoutUntil.getTime() > now;

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      onError(err.message || 'Could not reach server');
    }
    setBusy('');
  };

  const handlePhotoFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { onError('Please choose a valid image file (JPG, PNG, WebP, or GIF).'); return; }
    if (file.size > MAX_FILE_BYTES) { onError('That photo is too large — please pick one under 6 MB.'); return; }
    setPhotoBusy(true);
    try {
      const compressed = await compressPhoto(file);
      setPhotoPick({ mime: compressed.mime, data: compressed.data, preview: compressed.preview });
      setPhotoRemove(false);
    } catch (err) {
      onError(err.message || 'Could not process that photo.');
    }
    setPhotoBusy(false);
  };

  const saveInfo = () => run('info', async () => {
    const patch = {};
    if (fullName !== (user.fullName || '')) patch.fullName = fullName.trim();
    if (username !== user.username) patch.username = username.trim();
    if (verified !== !!user.verified) patch.verified = verified;
    if (photoPick) patch.photo = { mime: photoPick.mime, data: photoPick.data };
    else if (photoRemove) patch.photo = null;
    const photoChanged = !!photoPick || photoRemove;

    const res = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { onError(data.error || 'Could not save changes'); return; }
    setPhotoPick(null); setPhotoRemove(false);
    onUpdated(data, photoChanged);
    onToast(`Saved @${data.username}`);
  });

  const addTag = (raw) => {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(tag)) { onError('Tags may use letters, numbers, - and _ (max 24 chars).'); return; }
    if (user.tags.includes(tag)) { setTagInput(''); return; }
    pushTags([...user.tags, tag]);
  };

  const removeTag = (tag) => {
    if (tag === 'admin' && isSelf) { onError('You cannot remove your own admin tag.'); return; }
    if (tag === 'admin' && !window.confirm(`Remove the admin tag from @${user.username}?\n\nThey will lose access to the Admin panel and Applications page immediately.`)) return;
    pushTags(user.tags.filter(t => t !== tag));
  };

  const pushTags = (tags) => run('tags', async () => {
    const res = await api(`/api/admin/users/${user.id}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { onError(data.error || 'Could not update tags'); return; }
    onUpdated(data);
    setTagInput('');
  });

  const applyTimeout = (payload, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    run('timeout', async () => {
      const res = await api(`/api/admin/users/${user.id}/timeout`, { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || 'Could not update timeout'); return; }
      onUpdated(data);
      onToast(payload.clear ? `Timeout lifted for @${user.username}` : `@${user.username} timed out until ${fmtDateTime(parseIso(data.timeoutUntil))}`);
    });
  };

  const setPassword = () => {
    if (newPassword.length < 6) { onError('Password must be at least 6 characters.'); return; }
    if (!window.confirm(`Set a new password for @${user.username}?\n\nShare it with them securely — consider also requiring a change at next login.`)) return;
    run('password', async () => {
      const res = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ password: newPassword }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || 'Could not set password'); return; }
      setNewPassword('');
      onUpdated(data);
      onToast(`Password set for @${user.username}`);
    });
  };

  const toggleForceReset = () => {
    const next = !user.mustChangePassword;
    const msg = next
      ? `Require @${user.username} to reset their password?\n\nAt their next sign-in they must verify their current password and choose a new one.`
      : `Stop requiring a password reset for @${user.username}?`;
    if (!window.confirm(msg)) return;
    run('forceReset', async () => {
      const res = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ mustChangePassword: next }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || 'Could not update password-reset flag'); return; }
      onUpdated(data);
      onToast(next ? `@${user.username} must reset their password at next login` : `Password-reset requirement cleared`);
    });
  };

  const btnGhost = { border: '1px solid var(--border)', color: 'var(--text-muted)' };

  return (
    <div className="rounded-xl overflow-hidden"
         style={{ background: 'var(--bg-elevated)', border: `1px solid ${timedOut ? 'rgba(239,68,68,0.35)' : 'var(--border)'}` }}>

      {/* Row header — click to expand */}
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left transition-colors"
              style={{ background: expanded ? 'rgba(21,60,35,0.03)' : 'transparent' }}
              onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = 'rgba(21,60,35,0.035)'; }}
              onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = 'transparent'; }}>
        <Avatar user={user} photos={photos} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {user.fullName || user.username}
            </span>
            {user.fullName && (
              <span className="text-xs truncate" style={{ color: 'var(--text-subtle)' }}>@{user.username}</span>
            )}
            {user.admin && (
              <span className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(255,199,44,0.12)', color: '#a16207', border: '1px solid rgba(255,199,44,0.32)', lineHeight: 1 }}>
                ADMIN
              </span>
            )}
            {user.verified && <BadgeCheck className="w-3.5 h-3.5 shrink-0" style={{ color: '#166534' }} />}
            {isSelf && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-overlay)', color: 'var(--text-subtle)', border: '1px solid var(--border)', lineHeight: 1 }}>
                you
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {user.tags.filter(t => t !== 'admin').map(t => <TagPill key={t} tag={t} xs />)}
            {timedOut && (
              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(239,68,68,0.1)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.25)', lineHeight: 1.2 }}>
                <Ban className="w-3 h-3" /> timed out · {fmtRemaining(timeoutUntil.getTime() - now)}
              </span>
            )}
            {user.mustChangePassword && (
              <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(245,158,11,0.1)', color: '#b45309', border: '1px solid rgba(245,158,11,0.25)', lineHeight: 1.2 }}>
                <KeyRound className="w-3 h-3" /> reset required
              </span>
            )}
          </div>
        </div>
        <ChevronDown className="w-4 h-4 shrink-0 transition-transform"
                     style={{ color: 'var(--text-subtle)', transform: expanded ? 'rotate(180deg)' : 'none' }} />
      </button>

      {/* Expanded editor */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-5" style={{ borderTop: '1px solid var(--border)' }}>

          {/* Account info */}
          <section>
            <h4 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
              Account info
            </h4>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Full name">
                <input type="text" value={fullName} maxLength={80}
                  onChange={e => setFullName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={inputStyle} />
              </Field>
              <Field label="Username">
                <input type="text" value={username} maxLength={32}
                  onChange={e => setUsername(e.target.value.toLowerCase())}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={inputStyle} />
              </Field>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-3">
              <PhotoPicker
                preview={photoPreview}
                busy={photoBusy}
                onFile={handlePhotoFile}
                onClear={() => {
                  if (photoPick) { setPhotoPick(null); return; }        // discard unsaved pick
                  if (user.hasPhoto) setPhotoRemove(true);              // mark existing for deletion
                }}
                clearLabel={photoPick ? 'Discard new photo' : 'Remove photo'}
              />
              <button type="button" onClick={() => setVerified(v => !v)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors shrink-0 self-start"
                style={{
                  background: verified ? 'rgba(34,197,94,0.12)' : 'var(--bg-base)',
                  color: verified ? '#166534' : 'var(--text-muted)',
                  border: `1px solid ${verified ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
                }}>
                {verified ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                Verified badge {verified ? 'on' : 'off'}
              </button>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <button type="button" onClick={saveInfo} disabled={!dirty || busy === 'info'}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
                style={{ background: dirty ? 'var(--accent)' : 'var(--bg-base)', color: dirty ? '#fff' : 'var(--text-subtle)' }}>
                <Save className="w-3.5 h-3.5" /> {busy === 'info' ? 'Saving…' : 'Save changes'}
              </button>
              {dirty && <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>unsaved changes</span>}
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--text-subtle)' }}>
              Joined {fmtDateTime(parseTs(user.createdAt))}
              {user.lastSeen ? ` · last active ${fmtDateTime(parseTs(user.lastSeen))}` : ' · never signed in'}
            </p>
          </section>

          {/* Tags */}
          <section>
            <h4 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
              Role tags
            </h4>
            <div className="flex items-center gap-1.5 flex-wrap mb-2 min-h-7">
              {user.tags.length === 0 && <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>No tags yet</span>}
              {user.tags.map(t => (
                <TagPill key={t} tag={t} onRemove={() => removeTag(t)}
                         title={t === 'admin' ? 'Grants full admin access' : `Remove tag "${t}"`} />
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" value={tagInput} placeholder="add a tag…" maxLength={24}
                onChange={e => setTagInput(e.target.value.toLowerCase())}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-xs outline-none"
                style={inputStyle} />
              <button type="button" onClick={() => addTag(tagInput)} disabled={busy === 'tags'}
                className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
                style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                Add
              </button>
            </div>
            <div className="flex gap-1.5 flex-wrap mt-2">
              {SUGGESTED_TAGS.filter(t => !user.tags.includes(t)).map(t => (
                <button key={t} type="button" onClick={() => addTag(t)} disabled={busy === 'tags'}
                  className="px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-40"
                  style={{ border: '1px dashed var(--border-light)', color: 'var(--text-subtle)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--text-subtle)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; e.currentTarget.style.borderColor = 'var(--border-light)'; }}>
                  + {t}
                </button>
              ))}
            </div>
            <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: 'var(--text-subtle)' }}>
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              The <strong style={{ color: '#a16207' }}>admin</strong> tag controls who can see the Admin
              and Applications tabs — changes apply immediately.
            </p>
          </section>

          {/* Timeout */}
          <section>
            <h4 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
              Timeout
            </h4>
            {timedOut ? (
              <div className="rounded-lg p-3 mb-3 flex flex-col sm:flex-row sm:items-center gap-3"
                   style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)' }}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium" style={{ color: '#dc2626' }}>
                    <Ban className="w-3.5 h-3.5 inline mr-1.5" />
                    Timed out until {fmtDateTime(timeoutUntil)} ({fmtRemaining(timeoutUntil.getTime() - now)})
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    They can sign in and read, but cannot post messages, propose events, or vote.
                  </p>
                </div>
                <button type="button" onClick={() => applyTimeout({ clear: true })} disabled={busy === 'timeout'}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors shrink-0 disabled:opacity-40"
                  style={{ background: 'rgba(34,197,94,0.12)', color: '#166534', border: '1px solid rgba(34,197,94,0.3)' }}>
                  <TimerOff className="w-3.5 h-3.5" /> Lift timeout
                </button>
              </div>
            ) : (
              <p className="text-xs mb-3" style={{ color: 'var(--text-subtle)' }}>
                A timed-out member can still sign in and read the board, but posting is blocked until the timeout ends.
              </p>
            )}

            {isSelf ? (
              <p className="text-xs" style={{ color: 'var(--text-subtle)' }}>You cannot time yourself out.</p>
            ) : (
              <>
                <div className="flex gap-1.5 flex-wrap">
                  {TIMEOUT_PRESETS.map(p => (
                    <button key={p.minutes} type="button" disabled={busy === 'timeout'}
                      onClick={() => applyTimeout({ minutes: p.minutes })}
                      className="px-2.5 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-40"
                      style={btnGhost}
                      onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.35)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 mt-2 items-center">
                  <input type="datetime-local" value={customUntil}
                    onChange={e => setCustomUntil(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-xs outline-none"
                    style={{ ...inputStyle, colorScheme: 'dark' }} />
                  <button type="button" disabled={!customUntil || busy === 'timeout'}
                    onClick={() => {
                      const when = new Date(customUntil);
                      if (isNaN(when.getTime())) { onError('That date is not valid'); return; }
                      applyTimeout({ until: when.toISOString() });
                      setCustomUntil('');
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 shrink-0"
                    style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                    Until date
                  </button>
                  {timedOut && (
                    <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-subtle)' }}>applies on top of / replaces the current timeout</span>
                  )}
                </div>
              </>
            )}
          </section>

          {/* Password */}
          <section>
            <h4 className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
              Password
            </h4>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
              <div className="relative flex-1 min-w-0">
                <input type="text" value={newPassword} placeholder="new password (min 6 chars)"
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 pr-24 rounded-lg text-sm outline-none"
                  style={inputStyle} />
                <button type="button" title="Generate a temporary password"
                  onClick={() => setNewPassword(genTempPassword())}
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 rounded text-xs"
                  style={{ color: 'var(--text-subtle)', border: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
                  <RotateCcw className="w-3 h-3" /> generate
                </button>
              </div>
              <button type="button" onClick={setPassword} disabled={!newPassword || busy === 'password'}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 shrink-0"
                style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                <KeyRound className="w-3.5 h-3.5" /> {busy === 'password' ? 'Setting…' : 'Set password'}
              </button>
            </div>
            <button type="button" onClick={toggleForceReset} disabled={busy === 'forceReset'}
              className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
              style={{
                background: user.mustChangePassword ? 'rgba(245,158,11,0.1)' : 'var(--bg-base)',
                color: user.mustChangePassword ? '#b45309' : 'var(--text-muted)',
                border: `1px solid ${user.mustChangePassword ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`,
              }}>
              {user.mustChangePassword ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              {user.mustChangePassword
                ? 'Reset at next login: REQUIRED — click to clear'
                : 'Require password reset at next login'}
            </button>
            <p className="text-xs mt-2" style={{ color: 'var(--text-subtle)' }}>
              With the reset flag on, the member must confirm their current password and pick a new
              one the next time they sign in. Typical flow: set a temporary password, keep the flag on,
              share the temp password privately.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

// ── create-account form ──────────────────────────────────────────────────────
function CreateAccountCard({ api, onCreated, onError, onClose }) {
  const [username, setUsername]   = useState('');
  const [fullName, setFullName]   = useState('');
  const [password, setPassword]   = useState('');
  const [verified, setVerified]   = useState(true);
  const [forceReset, setForceReset] = useState(true);
  const [tags, setTags]           = useState([]);
  const [tagInput, setTagInput]   = useState('');
  const [photo, setPhoto]         = useState(null); // { mime, data, preview }
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy]           = useState(false);

  const handlePhotoFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { onError('Please choose a valid image file.'); return; }
    if (file.size > MAX_FILE_BYTES) { onError('That photo is too large — please pick one under 6 MB.'); return; }
    setPhotoBusy(true);
    try {
      const c = await compressPhoto(file);
      setPhoto({ mime: c.mime, data: c.data, preview: c.preview });
    } catch (err) { onError(err.message || 'Could not process that photo.'); }
    setPhotoBusy(false);
  };

  const addTag = (raw) => {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(tag)) { onError('Tags may use letters, numbers, - and _ (max 24 chars).'); return; }
    if (!tags.includes(tag)) setTags(t => [...t, tag]);
    setTagInput('');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim()) { onError('Username is required'); return; }
    if (password.length < 6) { onError('Password must be at least 6 characters (or hit Generate).'); return; }
    setBusy(true);
    try {
      const res = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          fullName: fullName.trim(),
          password,
          verified,
          mustChangePassword: forceReset,
          tags,
          photo: photo ? { mime: photo.mime, data: photo.data } : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || 'Could not create account'); setBusy(false); return; }
      onCreated(data, password);
    } catch {
      onError('Could not reach server');
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="rounded-xl p-4 sm:p-5 mb-4"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--accent)' }}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <UserPlus className="w-4 h-4" style={{ color: 'var(--accent)' }} /> New account
        </h3>
        <button type="button" onClick={onClose} className="p-1 rounded" style={{ color: 'var(--text-subtle)' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Username *">
          <input type="text" value={username} onChange={e => setUsername(e.target.value.toLowerCase())}
            placeholder="theirname" required maxLength={32}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />
        </Field>
        <Field label="Full name">
          <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
            placeholder="Alex Nguyen" maxLength={80}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />
        </Field>
        <Field label="Initial password *">
          <div className="relative">
            <input type="text" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="min 6 characters" required
              className="w-full px-3 py-2 pr-24 rounded-lg text-sm outline-none" style={inputStyle} />
            <button type="button" onClick={() => setPassword(genTempPassword())}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 rounded text-xs"
              style={{ color: 'var(--text-subtle)', border: '1px solid var(--border)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-subtle)'}>
              <RotateCcw className="w-3 h-3" /> generate
            </button>
          </div>
        </Field>
        <div>
          <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Photo (optional)</label>
          <PhotoPicker preview={photo?.preview || null} busy={photoBusy}
            onFile={handlePhotoFile}
            onClear={() => setPhoto(null)}
            clearLabel="Discard photo" />
        </div>
      </div>

      <div className="mt-3">
        <label className="block text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>Initial tags</label>
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {tags.map(t => <TagPill key={t} tag={t} onRemove={() => setTags(prev => prev.filter(x => x !== t))} />)}
          {tags.length === 0 && <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>none — regular member</span>}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {SUGGESTED_TAGS.filter(t => !tags.includes(t)).map(t => (
            <button key={t} type="button" onClick={() => addTag(t)}
              className="px-2 py-1 rounded-md text-xs"
              style={{ border: '1px dashed var(--border-light)', color: 'var(--text-subtle)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-subtle)'; }}>
              + {t}
            </button>
          ))}
          <input type="text" value={tagInput} placeholder="custom…" maxLength={24}
            onChange={e => setTagInput(e.target.value.toLowerCase())}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }}
            className="px-2 py-1 rounded-md text-xs outline-none w-24" style={inputStyle} />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mt-4">
        <button type="button" onClick={() => setVerified(v => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
          style={{
            background: verified ? 'rgba(34,197,94,0.12)' : 'var(--bg-base)',
            color: verified ? '#166534' : 'var(--text-muted)',
            border: `1px solid ${verified ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
          }}>
          {verified ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />} Verified badge
        </button>
        <button type="button" onClick={() => setForceReset(v => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
          style={{
            background: forceReset ? 'rgba(245,158,11,0.1)' : 'var(--bg-base)',
            color: forceReset ? '#b45309' : 'var(--text-muted)',
            border: `1px solid ${forceReset ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`,
          }}>
          {forceReset ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          Must change password at first login
        </button>
      </div>

      <button type="submit" disabled={busy || photoBusy}
        className="w-full mt-4 py-2.5 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
        style={{ background: 'var(--accent)', color: '#fff' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function AdminPage({ session }) {
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast]       = useState('');
  const [photos, setPhotos]     = useState({}); // userId → object URL
  const [photoV, setPhotoV]     = useState({}); // userId → cache-buster
  const [now, setNow]           = useState(Date.now());
  const photosRef = useRef({});
  const toastTimer = useRef(null);

  const api = useCallback((path, opts = {}) => fetch(path, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${session.token}`,
    },
  }), [session.token]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }, []);

  // tick for timeout countdowns
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // fetch a member photo into an object URL (cached per user + version)
  const loadPhoto = useCallback(async (id, v) => {
    const key = `${id}:${v}`;
    if (photosRef.current[key]) return;
    photosRef.current[key] = 'loading';
    try {
      const res = await api(`/api/users/${id}/photo`);
      if (!res.ok) { photosRef.current[key] = null; return; }
      const url = URL.createObjectURL(await res.blob());
      photosRef.current[key] = url;
      setPhotos(p => ({ ...p, [id]: url }));
    } catch { photosRef.current[key] = null; }
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api('/api/admin/users');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Turn the common deployment mistakes into self-explanatory messages.
        const hint =
          res.status === 404
            ? 'Could not load members — the API server is running an older build without /api/admin/users. Rebuild and restart it (Docker: ./scripts/deploy.sh or docker compose up -d --build api · dev: restart the backend, npm run dev:backend).'
            : res.status === 403
              ? 'Could not load members — the server no longer treats this session as an admin. Sign out and back in; if the tab should be yours, run scripts/set-admin.sh <username> on the server.'
              : res.status === 401
                ? 'Session expired — sign out and sign in again.'
                : (data.error || `Could not load members (HTTP ${res.status})`);
        setError(hint);
        setUsers([]);
        return;
      }
      const list = await res.json();
      setUsers(list);
      for (const u of list) if (u.hasPhoto) loadPhoto(u.id, photoV[u.id] || 0);
    } catch {
      setError('Could not reach server');
    } finally {
      setLoading(false);
    }
  }, [api, loadPhoto, photoV]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [api]);

  // revoke object URLs on unmount
  useEffect(() => () => {
    Object.values(photosRef.current).forEach(v => { if (typeof v === 'string') URL.revokeObjectURL(v); });
  }, []);

  const replaceUser = useCallback((updated, photoChanged = false) => {
    setUsers(prev => prev.map(u => (u.id === updated.id ? { ...u, ...updated } : u)));
    if (photoChanged) {
      const id = updated.id;
      setPhotos(p => {
        const old = p[id];
        if (old) URL.revokeObjectURL(old);
        const copy = { ...p };
        delete copy[id];
        return copy;
      });
      setPhotoV(v => {
        const next = (v[id] || 0) + 1;
        if (updated.hasPhoto) loadPhoto(id, next);
        return { ...v, [id]: next };
      });
    }
  }, [loadPhoto]);

  const filtered = search.trim()
    ? users.filter(u => {
        const q = search.trim().toLowerCase();
        return u.username.toLowerCase().includes(q) ||
               (u.fullName || '').toLowerCase().includes(q) ||
               u.tags.some(t => t.includes(q));
      })
    : users;

  const timedOutCount = users.filter(u => u.timeoutUntil && new Date(u.timeoutUntil).getTime() > now).length;
  const resetCount    = users.filter(u => u.mustChangePassword).length;
  const adminCount    = users.filter(u => u.admin).length;

  return (
    <div className="min-h-screen py-8 sm:py-16 px-3 sm:px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-6 sm:mb-8">
          <p className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
            Admin
          </p>
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2"
                  style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                <ShieldCheck className="w-5 h-5" style={{ color: '#a16207' }} /> Admin Panel
              </h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Manage members, tags, photos, timeouts, and accounts.
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => load()} title="Refresh"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-colors"
                style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </button>
              <button onClick={() => { setShowCreate(s => !s); setExpandedId(null); }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ background: showCreate ? 'var(--bg-overlay)' : 'var(--accent)', color: showCreate ? 'var(--text-muted)' : '#fff', border: `1px solid ${showCreate ? 'var(--border)' : 'var(--accent)'}` }}>
                {showCreate ? <X className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
                {showCreate ? 'Cancel' : 'New account'}
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-2 flex-wrap mt-4">
            {[
              { icon: Users, label: `${users.length} member${users.length === 1 ? '' : 's'}`, color: 'var(--text-muted)' },
              { icon: ShieldCheck, label: `${adminCount} admin${adminCount === 1 ? '' : 's'}`, color: '#a16207' },
              { icon: Ban, label: `${timedOutCount} timed out`, color: timedOutCount ? '#dc2626' : 'var(--text-subtle)' },
              { icon: KeyRound, label: `${resetCount} reset pending`, color: resetCount ? '#b45309' : 'var(--text-subtle)' },
            ].map(({ icon: Icon, label, color }) => (
              <span key={label} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg"
                    style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', color }}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </span>
            ))}
          </div>
        </div>

        {/* Create form */}
        {showCreate && (
          <CreateAccountCard
            api={api}
            onError={setError}
            onClose={() => setShowCreate(false)}
            onCreated={(created, tempPassword) => {
              setUsers(prev => [...prev, created].sort((a, b) => a.username.localeCompare(b.username)));
              setShowCreate(false);
              setExpandedId(created.id);
              if (created.hasPhoto) loadPhoto(created.id, 0);
              showToast(`Created @${created.username}${created.mustChangePassword ? ` — share their temporary password (${tempPassword}) privately; they'll choose a new one at first sign-in` : ''}`);
            }}
          />
        )}

        {/* Search */}
        <div className="relative mb-4">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-subtle)' }} />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search members or tags…"
            className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
        </div>

        {error && (
          <div className="text-sm px-4 py-3 rounded-lg mb-4 flex items-start justify-between gap-3"
               style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.15)' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} className="shrink-0"><X className="w-4 h-4" /></button>
          </div>
        )}

        {loading && users.length === 0 && (
          <div className="py-16 text-center">
            <div className="w-6 h-6 rounded-full mx-auto mb-4 animate-spin"
                 style={{ border: '1.5px solid var(--border-light)', borderTopColor: 'var(--accent)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading members…</p>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="py-16 text-center rounded-xl"
               style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
            <Users className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--text-subtle)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {search.trim() ? `No members match “${search.trim()}”.` : 'No member accounts yet.'}
            </p>
          </div>
        )}

        {/* Member list */}
        <div className="space-y-3">
          {filtered.map(u => (
            <MemberCard
              key={u.id}
              user={u}
              isSelf={u.id === session.userId}
              photos={photos}
              expanded={expandedId === u.id}
              onToggle={() => setExpandedId(id => (id === u.id ? null : u.id))}
              api={api}
              now={now}
              onError={setError}
              onToast={showToast}
              onUpdated={replaceUser}
            />
          ))}
        </div>

        <p className="mt-8 text-xs text-center leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
          <Clock className="w-3 h-3 inline mr-1" />
          Timeouts block posting but still allow reading. Members with “reset required” choose a new
          password at their next sign-in. Tag and admin changes take effect immediately.
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg text-xs shadow-lg max-w-md text-center"
             style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(34,197,94,0.35)', color: 'var(--text-primary)' }}>
          <Check className="w-3.5 h-3.5 inline mr-1.5" style={{ color: '#166534' }} />
          {toast}
        </div>
      )}
    </div>
  );
}
