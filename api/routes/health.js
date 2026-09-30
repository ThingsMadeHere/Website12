'use strict';
// ── health check ─────────────────────────────────────────────────────────────
const express = require('express');

const router = express.Router();

router.get('/', (_, res) => res.json({ ok: true }));

module.exports = router;
