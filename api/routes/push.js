'use strict';
// ── push notification routes ─────────────────────────────────────────────────
// Web Push subscription management. The subscription store & delivery live in
// modules/push.js; this is the thin HTTP layer. Mounted at /api ('/push/...').

const express = require('express');
const { requireAuth } = require('../auth');
const {
  registerSubscription, removeSubscription, getSubscription, vapidPublicKey,
} = require('../modules/push');

const router = express.Router();

// GET /api/push/vapid-key — public VAPID key for subscription
router.get('/push/vapid-key', (_, res) => {
  if (!vapidPublicKey) {
    return res.status(500).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: vapidPublicKey });
});

// POST /api/push/subscribe — register push subscription for current user
router.post('/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  registerSubscription(req.user.id, subscription);
  res.json({ ok: true });
});

// POST /api/push/unsubscribe — remove push subscription for current user
router.post('/push/unsubscribe', requireAuth, (req, res) => {
  removeSubscription(req.user.id);
  res.json({ ok: true });
});

// GET /api/push/subscription — get current user's subscription status
router.get('/push/subscription', requireAuth, (req, res) => {
  const subscription = getSubscription(req.user.id);
  res.json({ subscribed: !!subscription });
});

module.exports = router;
