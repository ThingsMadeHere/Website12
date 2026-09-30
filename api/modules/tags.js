'use strict';
// ── user tags: shared domain logic ───────────────────────────────────────────
// Lowercase role labels (mentor, lead, alumni, …). 'admin' is special: it is
// always kept in sync with the users.admin column. The admin panel and any
// other module that touches tags goes through this file.

const { db } = require('../db');

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const MAX_TAGS = 8;

// Returns { tags: string[] } or { error: string }.
function normalizeTags(input) {
  if (!Array.isArray(input)) return { error: 'tags must be an array' };
  const seen = new Set();
  for (const raw of input) {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag) continue;
    if (!TAG_RE.test(tag))
      return { error: `Tag "${tag}" is invalid — use letters, numbers, - and _ (max 24 chars)` };
    seen.add(tag);
  }
  if (seen.size > MAX_TAGS)
    return { error: `Too many tags — a member can have at most ${MAX_TAGS}` };
  return { tags: [...seen].sort() };
}

// Replace a user's full tag set (transactional). Syncs the admin flag.
function replaceTags(userId, tags) {
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM user_tags WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_tags (user_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(userId, t);
    // The 'admin' tag IS the admin flag — keep them in sync.
    db.prepare('UPDATE users SET admin = ? WHERE id = ?').run(tags.includes('admin') ? 1 : 0, userId);
  });
  apply();
}

module.exports = { TAG_RE, MAX_TAGS, normalizeTags, replaceTags };
