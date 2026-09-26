// Seeds the fixed test admin used by test/e2e.js.
// Run with the SAME DATABASE_PATH as the server under test:
//   DATABASE_PATH=/tmp/test.db node test/seed-admin.js
'use strict';

const { db } = require('../db');
const { hashPassword } = require('../auth');

const USERNAME = 'testadmin';
const PASSWORD = 'adminpass123';

db.prepare(
  `INSERT OR IGNORE INTO users (username, password_hash, full_name, verified, admin)
   VALUES (?, ?, 'Test Admin', 1, 1)`
).run(USERNAME, hashPassword(PASSWORD));
db.prepare(
  `INSERT OR IGNORE INTO user_tags (user_id, tag) SELECT id, 'admin' FROM users WHERE username = ?`
).run(USERNAME);

// Open the self-service join flow for tests: seed a team key so the E2E
// suite can exercise POST /api/login/join without an interactive admin.
if (process.env.TEAM_KEY) {
  const { setJoinKey } = require('../auth');
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME);
  const r = setJoinKey(process.env.TEAM_KEY, row.id, 'test key');
  if (r.error) { console.error('TEAM_KEY rejected:', r.error); process.exit(1); }
  console.log(`team key seeded: ${process.env.TEAM_KEY}`);
}

console.log(`seeded @${USERNAME} (password: ${PASSWORD})`);
process.exit(0);
