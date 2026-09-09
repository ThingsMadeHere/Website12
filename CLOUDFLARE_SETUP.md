# Cloudflare Setup for mchsrobotics.dev

The whole site (public pages, board API, calendar) is served from a single
origin, so Cloudflare setup is straightforward.

## Recommended: Orange Cloud (Proxied)

1. Point the `mchsrobotics.dev` A record at your public IP (see
   `DNS_CONFIGURATION.md`).
2. In Cloudflare DNS, keep the record **proxied (orange cloud)**.
3. Cloudflare handles TLS automatically — set **SSL/TLS mode** to `Full`
   (or `Flexible` if your origin has no cert).

That's all that's required. The board uses plain HTTPS polling
(`GET /api/channels/:id/messages?after=…` every ~2.5 s), which proxies through
Cloudflare with no special configuration — no WebSockets, no federation ports.

## Optional tuning

- **Caching:** static assets in `dist/assets/` are content-hashed, so you can
  safely enable "Cache Everything" for `mchsrobotics.dev/assets/*`. Never cache
  `/api/*` (Cloudflare's default behavior already bypasses it).
- **Rocket Loader:** optional; the app is a small React bundle and doesn't need it.
- **WebSockets:** left off — not used by this site.

## Serving the site

- Docker: `docker compose up -d api web` (nginx serves `dist/` and proxies
  `/api` to the API container).
- Or Caddy with the provided `Caddyfile` (reverse-proxies `/api/*` to
  `mchs-api:3001` and serves the frontend).
