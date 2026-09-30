'use strict';
// ── calendar events: shared domain logic ─────────────────────────────────────
// The event row shape, Google-Calendar mirroring, push announcements and the
// reminder scheduler live here so both the /api/events routes (routes/events.js)
// and other backend modules (gcal direct writes, imports) talk to one source.
// Modules communicate through these exports — never by reaching into another
// module's route handlers.

const { db } = require('../db');
const gcal = require('../googleCalendar');
const {
  getSubscribedUserIds, sendPushNotification, sendMeetingReminderNotification,
} = require('./push');
const { sqlUtc, fmtEventWhen, getTimeUntilString } = require('./util');

const EVENT_TYPES = ['meeting', 'event', 'workshop', 'competition'];

function eventRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    date: row.date,
    location: row.location || '',
    type: row.type || 'meeting',
    status: row.status || 'pending',
    isMeeting: (row.type || 'meeting') === 'meeting',
    proposedBy: row.proposed_by != null && row.proposed_by !== '' ? Number(row.proposed_by) : null,
    proposerName: row.proposer_name || null,
    // Google Calendar mirror: set once the event has been written to the
    // team's Google Calendar; source marks president/admin direct writes.
    gcalEventId: row.gcal_event_id || null,
    source: row.source || 'portal',
  };
}

// Fire-and-forget mirror of an approved portal event into Google Calendar.
// Never blocks or fails the API call — syncPending() retries any misses.
function gcalMirror(event, action = 'insert') {
  if (!gcal.isConfigured()) return Promise.resolve();
  const run = async () => {
    try {
      if (action === 'insert' && !event.gcal_event_id) {
        const id = await gcal.insertEvent(event);
        if (id) db.prepare('UPDATE calendar_events SET gcal_event_id = ? WHERE id = ?').run(id, event.id);
      } else if (action === 'update' && event.gcal_event_id) {
        await gcal.updateEvent(event, event.gcal_event_id);
      } else if (action === 'delete' && event.gcal_event_id) {
        await gcal.deleteEvent(event.gcal_event_id);
      }
    } catch (err) {
      console.error(`[gcal] mirror ${action} failed for event ${event.id}:`, err.message);
    }
  };
  return run();
}

// Notify everyone subscribed to pushes that an event landed on the calendar.
// Aggressive delivery: a prominent "New event" announcement (tagged +
// renotify so it surfaces even if an older one is still on screen), plus the
// reminder-style push, plus scheduled follow-ups before the event starts.
function notifyEventApproved(event) {
  try {
    const subscribedUsers = getSubscribedUserIds();
    if (subscribedUsers.length === 0) return;
    const timeUntil = getTimeUntilString(new Date(event.date));
    const where = event.location || 'TBD';

    subscribedUsers.forEach(userId => {
      // Primary announcement
      sendPushNotification(userId, {
        title: `\u{1F4C5} New event: ${event.title}`,
        body: `${where} \u2014 ${fmtEventWhen(event.date)} (starting ${timeUntil}). Tap to view the calendar.`,
        data: { type: 'event_added', eventId: event.id, url: '/calendar' },
        tag: `event-${event.id}`,
        renotify: true,
        requireInteraction: true,
      }).catch(err => console.error('Push notification failed:', err.message));

      // Reminder-style push too, so it also lands in the reminders thread
      sendMeetingReminderNotification(userId, {
        meetingId: event.id,
        title: event.title,
        location: where,
        timeUntil: timeUntil,
      }).catch(err => console.error('Push notification failed:', err.message));
    });

    scheduleEventFollowups(event);
  } catch (err) {
    console.error('Failed to send push notifications for approved event:', err.message);
  }
}

// Follow-up nudges after an event lands on the calendar: a morning-of heads-up
// and an "almost time" push ~55 min before start (ahead of the scheduler's
// hourly window). In-process timers — best-effort, but they make pushes land
// far more often than the old announce-once-then-silence behavior.
const eventFollowupTimers = new Map(); // eventId -> [timer, …]
function scheduleEventFollowups(event) {
  try {
    const start = new Date(event.date);
    if (Number.isNaN(start.getTime())) return;

    (eventFollowupTimers.get(event.id) || []).forEach(clearTimeout);
    const timers = [];
    eventFollowupTimers.set(event.id, timers);

    const broadcast = (payload) => {
      getSubscribedUserIds().forEach(userId => {
        sendPushNotification(userId, payload)
          .catch(err => console.error('Push notification failed:', err.message));
      });
    };

    const queue = (when, build) => {
      const delay = when - Date.now();
      if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return; // skip stale / far-out
      timers.push(setTimeout(() => broadcast(build()), delay));
    };

    // Morning-of reminder (8:00 AM local on the event day, if still ahead)
    const morning = new Date(start); morning.setHours(8, 0, 0, 0);
    queue(morning, () => ({
      title: `\u{1F3C1} Today: ${event.title}`,
      body: `Starts ${fmtEventWhen(event.date).split(' at ')[1] ? 'at ' + start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'today'} \u2014 ${event.location || 'TBD'}. See you there!`,
      data: { type: 'event_reminder', eventId: event.id, url: '/calendar' },
      tag: `event-${event.id}-morning`,
      requireInteraction: true,
    }));

    // Heads-up ~55 minutes before start
    queue(new Date(start.getTime() - 55 * 60 * 1000), () => ({
      title: `\u23F0 Almost time: ${event.title}`,
      body: `Starting ${getTimeUntilString(start)} at ${event.location || 'TBD'}. Head over!`,
      data: { type: 'event_reminder', eventId: event.id, url: '/calendar' },
      tag: `event-${event.id}-soon`,
      renotify: true,
      requireInteraction: true,
    }));
  } catch (err) {
    console.error('Failed to schedule event follow-ups:', err.message);
  }
}

// ── meeting reminder scheduler ───────────────────────────────────────────────
// Check for upcoming meetings and send reminders periodically
// Track sent reminders to avoid duplicates
const sentReminders = new Set(); // eventId_timestamp

function scheduleMeetingReminders() {
  setInterval(async () => {
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      // Event dates are stored as LOCAL wall-clock strings ('YYYY-MM-DD' or
      // 'YYYY-MM-DDTHH:MM:SS'), so compare them against local time — using
      // sqlUtc() here (as before) meant reminders effectively never fired.
      const fmtLocal = (d) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

      // Get approved meetings starting within the next hour
      const rows = db.prepare(
        `SELECT * FROM calendar_events
         WHERE status = 'approved'
         AND date >= ?
         AND date <= ?`
      ).all(fmtLocal(now), fmtLocal(oneHourFromNow));

      for (const event of rows) {
        const eventDate = new Date(event.date);
        const timeUntil = getTimeUntilString(eventDate);
        const reminderKey = `${event.id}_${Math.floor(eventDate.getTime() / (60 * 60 * 1000))}`; // Unique key per hour

        // Only send if we haven't sent a reminder for this event in this hour
        if (!sentReminders.has(reminderKey)) {
          sentReminders.add(reminderKey);

          // Send reminder to all subscribed users
          const subscribedUsers = getSubscribedUserIds();
          if (subscribedUsers.length > 0) {
            subscribedUsers.forEach(userId => {
              sendMeetingReminderNotification(userId, {
                meetingId: event.id,
                title: event.title,
                location: event.location || 'TBD',
                timeUntil: timeUntil
              }).catch(err => console.error('Push notification failed:', err.message));
            });
          }
        }
      }
    } catch (err) {
      console.error('Meeting reminder check failed:', err);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

module.exports = {
  EVENT_TYPES,
  eventRow,
  gcalMirror,
  notifyEventApproved,
  scheduleEventFollowups,
  scheduleMeetingReminders,
};
