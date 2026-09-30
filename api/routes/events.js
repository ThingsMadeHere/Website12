'use strict';
// ── calendar event routes ────────────────────────────────────────────────────
// Members PROPOSE events (status 'pending') which move onto the calendar once
// a majority votes 👍. Admins can PUSH events straight onto the calendar
// (status 'approved', no voting required), approve or reject any proposal,
// and delete any event. Domain logic (row shape, Google mirror, push
// announcements, reminders) lives in modules/events.js. Mounted at /api.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin, blockIfTimedOut } = require('../auth');
const {
  EVENT_TYPES, eventRow, gcalMirror, notifyEventApproved,
} = require('../modules/events');

const router = express.Router();

// GET /api/events — all calendar events (approved + pending proposals)
router.get('/events', (_, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT e.*, u.username AS proposer_name
         FROM calendar_events e
         LEFT JOIN users u ON u.id = CAST(e.proposed_by AS INTEGER)
         ORDER BY e.date ASC`
      )
      .all();
    res.json(rows.map(eventRow));
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /api/events — create a calendar event.
// Members propose (status 'pending' → goes to the voting panel); admins may
// pass { push: true } to skip voting and land it on the calendar immediately.
router.post('/events', requireAuth, blockIfTimedOut, (req, res) => {
  const { title, description, date, location, type, push } = req.body || {};

  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });

  const evType = type || 'meeting';
  if (!EVENT_TYPES.includes(evType))
    return res.status(400).json({ error: 'type must be meeting, event, workshop, or competition' });

  // Only admins may bypass the vote workflow.
  const status = (push && req.user.admin) ? 'approved' : 'pending';

  try {
    const info = db
      .prepare(
        `INSERT INTO calendar_events (title, description, date, location, type, status, proposed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(String(title).trim(), description || '', date, location || '', evType, status, String(req.user.id));

    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid);
    if (status === 'approved') { notifyEventApproved(event); gcalMirror(event, 'insert'); }
    res.json(eventRow(event));
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// DELETE /api/events/:id — proposer deletes their own event; admins delete any
router.delete('/events/:id', requireAuth, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Numeric compare: better-sqlite3 v12 stores JS numbers bound into this TEXT
    // column as '3.0', so string equality against '3' would wrongly fail.
    const isProposer = event.proposed_by != null && event.proposed_by !== '' &&
      Number(event.proposed_by) === Number(req.user.id);
    if (!isProposer && !req.user.admin)
      return res.status(403).json({ error: 'You can only delete events you proposed' });

    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    if (event.gcal_event_id) gcalMirror(event, 'delete'); // keep Google in sync
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Update an event (admin or the original proposer). Used for edits and for
// toggling approved <-> pending without deleting/recreating (which would lose
// votes and recurring-seed linkage).
router.put('/events/:id', requireAuth, blockIfTimedOut, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isProposer = event.proposed_by != null && event.proposed_by !== '' &&
      Number(event.proposed_by) === Number(req.user.id);
    if (!isProposer && !req.user.admin)
      return res.status(403).json({ error: 'Only an admin or the proposer can edit this event' });

    const b = req.body || {};
    const next = {
      title:       b.title !== undefined ? String(b.title).trim() : event.title,
      description: b.description !== undefined ? (b.description || '') : (event.description || ''),
      date:        b.date !== undefined ? String(b.date) : event.date,
      location:    b.location !== undefined ? (b.location || '') : (event.location || ''),
      type:        b.type !== undefined ? b.type : (event.type || 'meeting'),
      status:      b.status !== undefined ? b.status : (event.status || 'pending'),
    };
    if (!next.title || !next.date) return res.status(400).json({ error: 'Title and date are required' });
    if (!EVENT_TYPES.includes(next.type)) return res.status(400).json({ error: `type must be one of ${EVENT_TYPES.join(', ')}` });
    if (!['pending', 'approved', 'rejected'].includes(next.status))
      return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
    // Only admins may (re-)approve directly.
    if (next.status === 'approved' && event.status !== 'approved' && !req.user.admin)
      return res.status(403).json({ error: 'Members cannot approve their own events — send it through voting' });
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$/.test(next.date))
      return res.status(400).json({ error: 'date must look like 2026-04-10 or 2026-04-10T16:00' });

    const wasApproved = event.status === 'approved';
    db.prepare(
      `UPDATE calendar_events SET title=?, description=?, date=?, location=?, type=?, status=? WHERE id=?`
    ).run(next.title, next.description, next.date, next.location, next.type, next.status, event.id);

    const updated = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
    if (!wasApproved && next.status === 'approved') { notifyEventApproved(updated); gcalMirror(updated, 'insert'); }
    else if (wasApproved && next.status !== 'approved') gcalMirror(updated, 'delete'); // pulled off the calendar → remove from Google too
    else if (wasApproved) gcalMirror(updated, 'update');                                // details changed → patch Google
    res.json(eventRow(updated));
  } catch (err) {
    console.error('Error updating event:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// GET /api/events/:id/votes — votes for an event
router.get('/events/:id/votes', (req, res) => {
  try {
    const rows = db.prepare('SELECT user_id, vote FROM event_votes WHERE event_id = ?').all(req.params.id);
    const votes = rows.reduce((acc, r) => { acc[r.user_id] = r.vote; return acc; }, {});
    res.json({ votes });
  } catch (err) {
    console.error('Error fetching votes:', err);
    res.status(500).json({ error: 'Failed to fetch votes' });
  }
});

// POST /api/events/:id/vote  { vote: 1 | -1 }
router.post('/events/:id/vote', requireAuth, blockIfTimedOut, (req, res) => {
  const vote = Number((req.body || {}).vote);
  if (vote !== 1 && vote !== -1)
    return res.status(400).json({ error: 'vote must be 1 or -1' });

  try {
    db.prepare(
      `INSERT INTO event_votes (event_id, user_id, vote) VALUES (?, ?, ?)
       ON CONFLICT(event_id, user_id) DO UPDATE SET vote = excluded.vote`
    ).run(req.params.id, req.user.id, vote);

    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END)  AS yes_votes,
           SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS no_votes,
           COUNT(*) AS total_votes
         FROM event_votes WHERE event_id = ?`
      )
      .get(req.params.id);

    let promoted = false;
    const ev = db.prepare(`SELECT status FROM calendar_events WHERE id = ?`).get(req.params.id);
    const yes = totals.yes_votes || 0, total = totals.total_votes || 0;
    if (ev && ev.status === 'pending' && total > 0 && yes >= Math.floor(total / 2) + 1) {
      db.prepare(`UPDATE calendar_events SET status = 'approved' WHERE id = ?`).run(req.params.id);
      const promotedEvent = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
      notifyEventApproved(promotedEvent);
      gcalMirror(promotedEvent, 'insert');
      promoted = true;
    }

    res.json({
      event_id: Number(req.params.id),
      yes_votes: yes,
      no_votes: totals.no_votes || 0,
      total_votes: total,
      promoted,
    });
  } catch (err) {
    console.error('Error voting on event:', err);
    res.status(500).json({ error: 'Failed to vote' });
  }
});

// PUT /api/events/:id/approve — put a proposal on the calendar.
// Anyone may call it, but it only succeeds once a majority voted yes; admins
// can force-approve any pending proposal (their word is enough — no votes
// needed).
router.put('/events/:id/approve', requireAuth, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'approved') {
      return res.json({ success: true, approved: true, message: 'Event is already on the calendar' });
    }
    if (event.status !== 'pending') {
      return res.status(400).json({ success: false, approved: false, error: `Event was ${event.status}` });
    }

    const totals = db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS yes_votes,
           COUNT(*) AS total_votes
         FROM event_votes WHERE event_id = ?`
      )
      .get(req.params.id);

    const totalVotes = totals.total_votes || 0;
    const yesVotes   = totals.yes_votes || 0;
    const majority   = totalVotes > 0 ? Math.floor(totalVotes / 2) + 1 : 0;

    // Admin decision counts as approval on its own; members need a vote majority.
    if (req.user.admin || (totalVotes > 0 && yesVotes >= majority)) {
      db.prepare(`UPDATE calendar_events SET status = 'approved' WHERE id = ?`).run(req.params.id);
      notifyEventApproved(event);
      gcalMirror(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id), 'insert');
      res.json({ success: true, approved: true, message: 'Event approved and added to calendar' });
    } else {
      res.status(400).json({
        success: false,
        approved: false,
        message: `Needs ${majority} votes (currently has ${yesVotes})`,
      });
    }
  } catch (err) {
    console.error('Error approving event:', err);
    res.status(500).json({ error: 'Failed to approve event' });
  }
});

// PUT /api/events/:id/reject  (admin) — deny a pending proposal outright,
// without waiting for (or requiring) a vote majority.
router.put('/events/:id/reject', requireAuth, requireAdmin, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'pending')
      return res.status(400).json({ error: `Only pending proposals can be rejected (this one is ${event.status})` });

    db.prepare(`UPDATE calendar_events SET status = 'rejected' WHERE id = ?`).run(req.params.id);
    console.log(`Event ${req.params.id} ("${event.title}") rejected by ${req.user.username}`);
    res.json({ success: true, rejected: true });
  } catch (err) {
    console.error('Error rejecting event:', err);
    res.status(500).json({ error: 'Failed to reject event' });
  }
});

module.exports = router;
