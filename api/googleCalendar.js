'use strict';
// ── Google Calendar sync (Option A: in-app calendar + voting, mirrored to Google) ─
// The portal stays the source of truth for proposals/voting/pushes; every event
// that lands on the portal calendar is ALSO written to the team's Google
// Calendar so students see it in their own calendars. The club president /
// admins can additionally write DIRECTLY to Google from the admin panel
// (POST /api/gcal/direct), which lands in Google and back in the portal.
//
// Auth: a Google Cloud service account (GOOGLE_SERVICE_ACCOUNT_JSON or
// GOOGLE_APPLICATION_CREDENTIALS pointing at the key file). Share the target
// calendar with the service-account email (Settings → "Share with specific
// people") and it gets editor rights. No OAuth consent screens, no tokens to
// refresh manually — perfect for a server/PM2-free container.
//
// Env:
//   GOOGLE_CALENDAR_ID            target calendar id ("primary" works if the
//                                 SA itself owns a calendar, but usually it's
//                                 something like abc123@group.calendar.google.com)
//   GOOGLE_SERVICE_ACCOUNT_JSON   inline JSON key (quote it in .env) OR
//   GOOGLE_APPLICATION_CREDENTIALS path to a key file
//   GOOGLE_CAL_SUMMARY_PREFIX     optional "[MCHS Robotics] " title prefix
//
// When unconfigured everything degrades gracefully: sync calls become no-ops
// and the API reports gcalConfigured:false so the UI can hide the controls.

const fs = require('fs');
const { google } = require('googleapis');

const SYNC_TTL_DAYS = 400; // events older than this are never re-synced

function isConfigured() {
  return !!process.env.GOOGLE_CALENDAR_ID &&
    (!!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim() ||
     !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim());
}

let cachedAuth = null;
let cachedAuthKey = '';

function getCalendarClient() {
  if (!isConfigured()) return null;
  const keySrc = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
    || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  if (!cachedAuth || cachedAuthKey !== keySrc) {
    let creds;
    const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
    if (inline) {
      try { creds = JSON.parse(inline); }
      catch { console.error('[gcal] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); return null; }
    } else {
      creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    }
    cachedAuth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    cachedAuthKey = keySrc;
  }
  return google.calendar({ version: 'v3', auth: cachedAuth });
}

// SQLite stores event dates as UTC strings ("2026-04-10 20:00:00" or ISO).
// Convert to an RFC3339 instant using the same parseSqliteUtc convention the
// rest of the API uses (naive strings are treated as UTC).
function toRfc3339(dateStr) {
  const s = String(dateStr || '').trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    d = new Date(s.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function eventSummary(title) {
  const prefix = (process.env.GOOGLE_CAL_SUMMARY_PREFIX || '').trim();
  return `${prefix}${title || 'MCHS Robotics event'}`.slice(0, 200);
}

async function insertEvent(event) {
  const calendar = getCalendarClient();
  if (!calendar) return null;
  const start = toRfc3339(event.date);
  if (!start) return null;
  const end = new Date(new Date(start).getTime() + 90 * 60 * 1000).toISOString();
  const descParts = [event.description || '', '', `— via the MCHS Robotics portal`];
  const res = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: eventSummary(event.title),
      location: event.location || undefined,
      description: descParts.join('\n'),
      startsAt: { dateTime: start },
      endsAt: { dateTime: end },
      source: {
        title: 'MCHS Robotics Portal',
        url: `${process.env.PUBLIC_URL || 'https://mchsrobotics.dev'}/calendar`,
      },
    },
  });
  return res.data.id || null;
}

async function updateEvent(event, geventId) {
  const calendar = getCalendarClient();
  if (!calendar || !geventId) return;
  const start = toRfc3339(event.date);
  if (!start) return;
  const end = new Date(new Date(start).getTime() + 90 * 60 * 1000).toISOString();
  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: geventId,
    requestBody: {
      summary: eventSummary(event.title),
      location: event.location || undefined,
      description: `${event.description || ''}\n\n— via the MCHS Robotics portal`,
      startsAt: { dateTime: start },
      endsAt: { dateTime: end },
    },
  });
}

async function deleteEvent(geventId) {
  const calendar = getCalendarClient();
  if (!calendar || !geventId) return;
  await calendar.events.delete({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: geventId,
  });
}

// Write directly to Google Calendar (president/admin quick-add). Returns the
// created event's id/htmlLink so the caller can also mirror it into the
// portal DB with source='gcal-direct'.
async function createDirect({ title, date, endDate, location, description }) {
  const calendar = getCalendarClient();
  if (!calendar) return { error: 'Google Calendar is not configured on this server (set GOOGLE_CALENDAR_ID + service-account credentials in api/.env).' };
  const start = toRfc3339(date);
  if (!start) return { error: 'date must look like 2026-04-10, 2026-04-10T16:00, or an ISO timestamp' };
  const end = toRfc3339(endDate) || new Date(new Date(start).getTime() + 90 * 60 * 1000).toISOString();
  const res = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: eventSummary(title),
      location: location || undefined,
      description: description || undefined,
      startsAt: { dateTime: start },
      endsAt: { dateTime: end },
    },
  });
  return { ok: true, event: { id: res.data.id, htmlLink: res.data.htmlLink, summary: res.data.summary } };
}

// Pull upcoming events straight from Google (for the admin panel preview and
// the one-time import).
async function listUpcoming(maxResults = 50) {
  const calendar = getCalendarClient();
  if (!calendar) return { error: 'Google Calendar is not configured.' };
  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: new Date().toISOString(),
    maxResults: Math.min(Math.max(Number(maxResults) || 50, 1), 250),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return {
    events: (res.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary || '',
      location: e.location || '',
      description: e.description || '',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      htmlLink: e.htmlLink || null,
    })),
  };
}

// Best-effort background sync of approved events that have no gcal linkage
// yet (e.g. events created before sync was enabled, or after a failed push).
// Never throws; logs failures so a bad token doesn't take down the loop.
async function syncPending(db) {
  if (!isConfigured()) return { synced: 0 };
  const rows = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE status = 'approved'
         AND (gcal_event_id IS NULL OR gcal_event_id = '')
         AND date >= datetime('now', '-${SYNC_TTL_DAYS} days')
       ORDER BY date ASC LIMIT 25`
    )
    .all();
  let synced = 0;
  for (const ev of rows) {
    try {
      const id = await insertEvent(ev);
      if (id) {
        db.prepare('UPDATE calendar_events SET gcal_event_id = ? WHERE id = ?').run(id, ev.id);
        synced++;
      }
    } catch (err) {
      console.error(`[gcal] sync failed for event ${ev.id}:`, err.message);
      break; // likely an auth/config problem — stop hammering Google
    }
  }
  return { synced };
}

module.exports = {
  isConfigured,
  insertEvent,
  updateEvent,
  deleteEvent,
  createDirect,
  listUpcoming,
  syncPending,
};
