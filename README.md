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

- **Accounts** — register/login with username + password (scrypt-hashed, session
  tokens). Optional "verified ✓" badge via photo upload step.
- **Board (chat)** — channel-based messaging (`#general`, `#announcements`,
  `#build`, `#programming` seeded; anyone signed in can create more). Pasted
  links (`https://…` and `www.…`) are automatically rendered as clickable links.
- **Calendar** — monthly meeting calendar. Members propose events, the team votes,
  and events with majority approval appear on the calendar.
- Home + FAQ pages for the public site.

> Migrated off Matrix/Dendrite in v2.0 — accounts, messages, and channels now
> live entirely in the local SQLite database. Calendar events created before the
> migration carry over automatically (same DB file).

## Project layout

```
├── src/                 React frontend
│   ├── App.jsx          navigation + session handling
│   └── components/
│       ├── LandingPage.jsx    login / register
│       ├── MessageBoard.jsx   the board: channels + messages (polling)
│       ├── CalendarPage.jsx   calendar widget
│       ├── EventDialog.jsx    propose-an-event dialog
│       ├── HomePage.jsx       public home
│       └── FAQ.jsx            public FAQ
├── api/                 Express backend
│   ├── index.js         all routes (/api/…)
│   ├── auth.js          password hashing + session tokens
│   ├── db.js            SQLite schema + seeds
│   └── mchs.db          the database (auto-created)
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

```bash
docker compose run --rm build-frontend   # builds React app into ./dist
docker compose up -d api web             # API + nginx serving the site
```

- The site is served on port **8888** (or via Nginx Proxy Manager on the
  `docker_default` network).
- The database persists in the `api_data` Docker volume
  (`DATABASE_PATH=/app/data/mchs.db`).

## API overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/register` | – | create account → session token |
| POST | `/api/login` | – | sign in → session token |
| POST | `/api/logout` | ✓ | destroy session |
| POST | `/api/verify` | ✓ | set verified ✓ badge |
| GET | `/api/users/verified` | – | userId → verified map |
| GET | `/api/channels` | ✓ | list channels |
| POST | `/api/channels` | ✓ | create channel |
| GET | `/api/channels/:id/messages` | ✓ | history / poll (`?after=<id>`) |
| POST | `/api/channels/:id/messages` | ✓ | post a message |
| GET | `/api/events` | – | calendar events |
| POST | `/api/events` | ✓ | propose event |
| DELETE | `/api/events/:id` | ✓ | delete event |
| POST | `/api/events/:id/vote` | ✓ | vote `{vote: 1 \| -1}` |
| PUT | `/api/events/:id/approve` | ✓ | approve if majority yes |

Auth = `Authorization: Bearer <token>` header.
