'use strict';
// ── Google Calendar routes (Option A: portal stays source of truth, mirrored
// to gcal). Mounted at /api by index.js — paths here are like '/gcal/config'.

const express = require('express');
const { db } = require('../db');
const gcal = require('../googleCalendar');
const { requireAuth, requireAdmin, blockIfTimedOut } = require('../auth');
const { eventRow, notifyEventApproved } = require('../modules/events');

const router = express.Router();

// GET /api/gcal/config — is sync set up on this server? (anyone; UI gates on it)
router.get('/gcal/config', (_, res) => {
  res.json({ configured: gcal.isConfigured() });
});

// GET /api/gcal/status — admin view: linkage + last errors surfaced via logs.
router.get('/gcal/status', requireAuth, requireAdmin, async (_, res) => {
  try {
    const linked = db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_events WHERE gcal_event_id IS NOT NULL AND gcal_event_id != ''`
    ).get().n;
    const pendingSync = db.prepare(
      `SELECT COUNT(*) AS n FROM calendar_events
       WHERE status = 'approved' AND (gcal_event_id IS NULL OR gcal_event_id = '')
         AND date >= datetime('now', '-400 days')`
    ).get().n;
    let lastSync = null;
    if (gcal.isConfigured()) {
      const list = await gcal.listUpcoming(1);
      lastSync = list.events ? new Date().toISOString() : (list.error || null);
    }
    res.json({ configured: gcal.isConfigured(), linked, pendingSync, reachable: !!lastSync && !String(lastSync).includes('not configured') });
  } catch (err) {
    console.error('gcal status failed:', err.message);
    res.json({ configured: gcal.isConfigured(), error: err.message });
  }
});

// POST /api/gcal/direct — the president/admin writes an event DIRECTLY to the
// team's Google Calendar (no voting), and it also lands on the portal calendar
// with source='gcal-direct' so members see it everywhere at once.
router.post('/gcal/direct', requireAuth, requireAdmin, blockIfTimedOut, async (req, res) => {
  if (!gcal.isConfigured())
    return res.status(503).json({ error: 'Google Calendar sync is not configured on this server (see api/.env.example).' });
  const { title, date, endDate, location, description } = req.body || {};
  if (!title || !date) return res.status(400).json({ error: 'Title and date are required' });
  try {
    const created = await gcal.createDirect({ title, date, endDate, location, description });
    if (created.error) return res.status(400).json({ error: created.error });
    // Mirror into the portal DB as an approved event (source-tagged).
    const info = db.prepare(
      `INSERT INTO calendar_events (title, description, date, location, type, status, proposed_by, gcal_event_id, source)
       VALUES (?, ?, ?, ?, 'event', 'approved', ?, ?, 'gcal-direct')`
    ).run(String(title).trim(), description || '', date, location || '', String(req.user.id), created.event.id);
    const event = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(info.lastInsertRowid);
    notifyEventApproved(event); // push subscribers that a new event landed
    res.json({ success: true, event: eventRow(event), google: created.event });
  } catch (err) {
    console.error('gcal direct create failed:', err.message);
    res.status(502).json({ error: `Google Calendar write failed: ${err.message}` });
  }
});

// GET /api/gcal/upcoming — preview what's currently on the Google calendar (admin)
router.get('/gcal/upcoming', requireAuth, requireAdmin, async (req, res) => {
  try {
    const list = await gcal.listUpcoming(req.query.maxResults || 50);
    if (list.error) return res.status(503).json({ error: list.error });
    res.json(list);
  } catch (err) {
    console.error('gcal upcoming failed:', err.message);
    res.status(502).json({ error: `Google Calendar read failed: ${err.message}` });
  }
});

// POST /api/gcal/import — one-time import of existing Google events into the
// portal calendar (skips anything already linked or same-titled-and-dated).
router.post('/gcal/import', requireAuth, requireAdmin, async (req, res) => {
  try {
    const list = await gcal.listUpcoming(250);
    if (list.error) return res.status(503).json({ error: list.error });
    let imported = 0;
    for (const ge of list.events) {
      if (!ge.start) continue;
      const exists = db.prepare('SELECT id FROM calendar_events WHERE gcal_event_id = ?').get(ge.id);
      if (exists) continue;
      db.prepare(
        `INSERT INTO calendar_events (title, description, date, location, type, status, proposed_by, gcal_event_id, source)
         VALUES (?, ?, ?, ?, 'event', 'approved', NULL, ?, 'gcal-import')`
      ).run(ge.summary || 'Google event', ge.description || '', ge.start, ge.location || '', ge.id);
      imported++;
    }
    res.json({ success: true, imported });
  } catch (err) {
    console.error('gcal import failed:', err.message);
    res.status(502).json({ error: `Google Calendar import failed: ${err.message}` });
  }
});

module.exports = router;
