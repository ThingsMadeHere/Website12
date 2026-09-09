# DNS Configuration for mchsrobotics.dev

One domain, one A record — the site, board API, and calendar are all served
from the same origin (no Matrix subdomains anymore).

## Required DNS Records

### A Record

```
Type: A
Name: @ (or leave blank)
Value: YOUR_PUBLIC_IP_ADDRESS
TTL: 3600 (or as low as your registrar allows)
```

- `mchsrobotics.dev` → YOUR_PUBLIC_IP

That's it. If you're behind Cloudflare (orange cloud), the same single record
works and TLS is handled by Cloudflare — see `CLOUDFLARE_SETUP.md`.

## What you no longer need

- ~~`matrix.mchsrobotics.dev` A record~~ — removed with the Matrix server
- ~~`_matrix._tcp` SRV record~~ — federation is gone
- ~~Port 8448~~ — closed
