# MCHS Robotics Website — Team Portal

Team portal for FRC Team 5728: a public team site plus a members-only area with a
**dead-simple messaging board**, a **meeting calendar**, and **accounts**.

## What's inside

| Piece | Tech |
|---|---|
| Frontend | React 19 + Vite + Tailwind CSS 4 |
| Backend | Node.js + Express |
| Database | SQLite (`better-sqlite3`) — one file, zero setup |
| Live updates | HTTP polling every 2.5 s (no WebSockets needed) |

### Features

- **Public site, members-only board** — Home, FAQ, and Calendar are open to
  everyone; the sign-in screen only appears when a visitor opens the Board.
- **Applications, not open registration** — visitors apply with their full
  name, a chosen username/password, and a required photo (compressed
  client-side). The account is **not** created yet: the admin gets an email
  with the photo attached and **Approve / Deny** buttons, and can also review
  the queue from the admin-only **Applications** page on the site. Approving
  creates the account with the ✓ verified badge; pending/denied applicants
  get a clear message when they try to sign in.
- **Admins** — the username `carter` is auto-promoted to admin (configured in
  `api/db.js` → `ADMIN_USERNAMES`; promotion runs on startup and on approval).
- **Admin panel** (admin-only **Admin** tab) — full member management:
  - **Role tags** — add/remove free-form tags (`mentor`, `lead`, `alumni`, …)
    per member; tags show as colored pills next to names on the board. The
    special **admin** tag grants/revokes admin access instantly (you can't
    remove your own).
  - **Account info & photos** — edit any member's full name, username,
    ✓ verified badge, and profile photo (photos approved through applications
    are kept on the account and used as board avatars).
  - **Timeouts** — quick presets (10 min → 1 week) or a custom end date/time.
    A timed-out member can still sign in and read, but posting messages,
    proposing events, and voting are blocked until it expires or is lifted.
    You can't time yourself out.
  - **Create accounts** — make an account for someone directly (username,
    name, optional photo, initial tags, generated temp password). Any pending
    application for that username is auto-denied.
  - **Forced password resets** — flag any member (or new account) with
    *must change password at next login*: their next sign-in asks them to
    confirm their current password and choose a new one before a session is
    issued. Admins can also set a password directly.
- **Board (chat)** — channel-based messaging (`#general`, `#announcements`,
  `#build`, `#programming` seeded; anyone signed in can create more). Pasted
  links (`https://…` and `www.…`) are automatically rendered as clickable
  links, and **direct image links** (`.png`, `.jpg`, `.gif`, `.webp`, …) render
  as inline embeds.
- **Message deletion** — members can delete their own messages; admins can
  delete anyone's. Deletions propagate to other open clients via the poll
  cycle (`message_deletions` tombstones). Calendar events follow the same
  rule: proposers delete their own, admins delete any.
- **Calendar** — monthly meeting calendar with **clickable days**: tap/click any
  day for its events (times, locations, details) plus that day's pending
  proposals. Members propose events, which land in the **“Proposals awaiting
  votes”** panel under the calendar (with the proposer's name). The team votes
  👍/👎; when a majority of voters say yes the event moves onto the calendar
  automatically. Proposers can delete their own proposals/events (admins can
  delete any).
- **Recurring weekly meetings** — Tuesday lunch (Room F1) and Wednesday
  after-school (Room C5, 4–6 PM) meetings are auto-seeded ~4 months ahead
  (`api/db.js` → `RECURRING_MEETINGS`), topped up every 6 h while the server
  runs. Seeding is idempotent, and an occurrence an admin deletes (holiday
  week) stays deleted.
- Home + FAQ pages for the public site.
- **Mobile-friendly** — responsive navigation, off-canvas channel drawer, and
  touch-friendly layouts throughout.

> Migrated off Matrix/Dendrite in v2.0 — accounts, messages, and channels now
> live entirely in the local SQLite database. Calendar events created before the
> migration carry over automatically (same DB file).

## Project layout

```
├── src/                 React frontend
│   ├── App.jsx          navigation + session handling
│   └── components/
│       ├── LandingPage.jsx    sign in / apply to join
│       ├── ApplicationsPage.jsx  admin review queue (approve/deny)
│       ├── MessageBoard.jsx   the board: channels + messages (polling)
│       ├── CalendarPage.jsx   calendar widget
│       ├── EventDialog.jsx    propose-an-event dialog
│       ├── HomePage.jsx       public home
│       └── FAQ.jsx            public FAQ
├── api/                 Express backend
│   ├── index.js         all routes (/api/…)
│   ├── auth.js          password hashing + session tokens
│   ├── mailer.js        application emails (Resend API or SMTP)
│   └── db.js            SQLite schema + seeds + migrations
├── ../JarvisData/database/mchs.db   the database (sibling of the repo, outside git)
├── docker-compose.yml   build-frontend / api / web services
├── nginx.conf           serves dist/ + proxies /api
└── Caddyfile            alternate reverse-proxy config
```

## Development

```bash
npm install                 # frontend deps
cd api && npm install       # backend deps

npm run dev:all             # backend on :3001, frontend on :5173
# or separately:
npm run dev:backend
npm run dev:frontend
```

Vite proxies `/api` → `http://localhost:3001` in dev (see `vite.config.js`).

## Production (Docker)

The full protocol — first-time server setup, deploys, backups, rollback,
CI/CD, monitoring — lives in **[`DEPLOYMENT.md`](DEPLOYMENT.md)**. The short
version:

```bash
./scripts/deploy.sh          # backup → build → health-gated rollout → verify
./scripts/healthcheck.sh     # api + SPA + proxy chain, any time
./scripts/backup.sh nightly  # hot SQLite backup + config bundle (cron'd)
./scripts/restore.sh backups/<file>.db.gz
./scripts/set-admin.sh <username>   # bootstrap/promote an admin
```

Or step by step:

```bash
docker compose run --rm build-frontend   # npm ci + vite build → ./dist
docker compose build api                 # reproducible api image (npm ci)
docker compose up -d api web             # web waits for api to be healthy
```

- nginx (`mchs-web`) serves `dist/` on port **80** and proxies `/api/*` to
  `mchs-api:3001`; Cloudflare fronts the domain (see `CLOUDFLARE_SETUP.md`).
- The database persists in the `api_data` Docker volume
  (`DATABASE_PATH=/app/data/mchs.db`). The sibling `../JarvisData/database/mchs.db` (outside
  the repo) is only a dev seed — production data lives in the volume and in `backups/`.
- Pushes to `main` deploy automatically once CI passes
  (`.github/workflows/`), provided the deploy secrets are configured —
  see `DEPLOYMENT.md` §7.

## Application-review email

New applications trigger an email to the admin with the applicant's name,
username, and photo attached, plus **Approve / Deny** buttons (token links —
clicking one creates or rejects the account immediately; no sign-in needed).
Configure a provider via environment variables on the `api` service
(already stubbed in `docker-compose.yml`):

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | where review emails go (default `physicsiscool314@gmail.com`) |
| `PUBLIC_URL` | base URL used for approve/deny links (e.g. `https://mchsrobotics.dev`) |
| `RESEND_API_KEY` | **Option A** — send via the Resend API (free tier needs no domain) |
| `EMAIL_FROM` | optional sender override for either provider |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | **Option B** — any SMTP server (Gmail works with an *app password*) |

Credentials live in **`api/.env`** (git-ignored — copy `api/.env.example`
and fill it in; on the server do the same before `docker compose up`, since
the `api` service reads it via `env_file`). If neither provider is
configured, the email (including the approve/deny links) is printed to the
server log instead — so the whole flow is testable locally without
credentials.

## API overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/applications` | – | submit name + username/password + photo → pending review |
| GET | `/api/applications/:id/decision` | token | email link: `?token=…&action=approve\|deny` |
| GET | `/api/applications` | admin | review queue (`?status=pending\|all`) |
| GET | `/api/applications/:id/photo` | admin | applicant photo bytes |
| POST | `/api/applications/:id/decision` | admin | `{ action: approve\|deny }` from the Applications page |
| POST | `/api/login` | – | sign in → session token (pending/denied applicants get a clear error; flagged accounts get `{ mustChangePassword: true }` instead of a token) |
| POST | `/api/password/reset` | – | complete a forced password change → session token |
| POST | `/api/logout` | ✓ | destroy session |
| GET | `/api/me` | ✓ | current account state (admin/tags/verified/timeout) — clients poll this to pick up admin changes live |
| POST | `/api/verify` | admin | set verified ✓ badge |
| GET | `/api/users/verified` | – | userId → verified map |
| GET | `/api/users/:id/photo` | self/admin | member profile photo bytes |
| GET | `/api/admin/users` | admin | list members (`?search=`), incl. tags, timeout, reset flag |
| POST | `/api/admin/users` | admin | create an account `{ username, password, fullName?, photo?, tags?, verified?, mustChangePassword? }` |
| PATCH | `/api/admin/users/:id` | admin | update `{ username?, fullName?, verified?, password?, mustChangePassword?, photo? }` (`photo: null` removes it) |
| PUT | `/api/admin/users/:id/tags` | admin | replace tag set `{ tags: [...] }` — the `admin` tag syncs the admin flag |
| POST | `/api/admin/users/:id/timeout` | admin | `{ minutes }` \| `{ until }` \| `{ clear: true }` — blocks posting, not reading |
| GET | `/api/channels` | ✓ | list channels |
| POST | `/api/channels` | ✓ | create channel |
| GET | `/api/channels/:id/messages` | ✓ | history / poll (`?after=<id>&afterDel=<delId>`) |
| POST | `/api/channels/:id/messages` | ✓ | post a message (blocked while timed out) |
| DELETE | `/api/messages/:id` | ✓ | delete own message (admins: any message) |
| GET | `/api/events` | – | calendar events |
| POST | `/api/events` | ✓ | propose event (blocked while timed out) |
| DELETE | `/api/events/:id` | ✓ | delete event |
| POST | `/api/events/:id/vote` | ✓ | vote `{vote: 1 \| -1}` (blocked while timed out) |
| PUT | `/api/events/:id/approve` | ✓ | approve if majority yes |

Auth = `Authorization: Bearer <token>` header.
