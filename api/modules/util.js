'use strict';
// ── shared utilities ─────────────────────────────────────────────────────────
// Small helpers used by more than one route module. Keeping them here avoids
// circular requires between the feature modules (events ↔ push, chat → events,
// …) — every backend module depends downward on util/db/auth only.

// Date → SQLite UTC "YYYY-MM-DD HH:MM:SS"
function sqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// SQLite UTC string (or null) → ISO-8601 for JSON responses
function isoOrNull(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Public base URL for links embedded in emails (approve/deny links, …).
function baseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

// HTML-escape for email/static-page templates.
function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Human-readable when-string for pushes: "today at 4:00 PM", "tomorrow at 12:00 PM"
function fmtEventWhen(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isTomorrow = d.getFullYear() === tomorrow.getFullYear() &&
                     d.getMonth() === tomorrow.getMonth() &&
                     d.getDate() === tomorrow.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isSameDayLocal(d, now)) return `today at ${time}`;
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

function isSameDayLocal(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "in 3 days", "in 40 minutes", …
function getTimeUntilString(date) {
  const now = new Date();
  const diff = date - now;

  if (diff <= 0) return 'starting soon';

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
  return 'starting soon';
}

module.exports = { sqlUtc, isoOrNull, baseUrl, esc, fmtEventWhen, isSameDayLocal, getTimeUntilString };
