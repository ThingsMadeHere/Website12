# Zulip Chat Integration Setup

This website now uses **Zulip** for team chat via iframe embedding. Zulip is an open-source team chat platform with threads, channels, and excellent integration features.

## Quick Start Options

### Option A: Zulip Cloud (Recommended - Easiest)
1. Sign up at https://zulip.com/
2. Create a free team workspace (up to 10 users)
3. Configure your domain's DNS to point to your Zulip Cloud URL
4. Access chat via: https://yourteam.zulipchat.com

### Option B: Self-Hosted (Requires Manual Setup)

The Docker container for Zulip has SSL certificate issues. For self-hosting:

1. **Download Zulip**:
   ```bash
   git clone https://github.com/zulip/zulip.git
   cd zulip
   ./tools/provision --hostname=chat.mchsrobotics.dev
   ```

2. **Configure SSL**:
   - Get a certificate (Let's Encrypt for free)
   - Or use self-signed for local dev

3. **Start Zulip**:
   ```bash
   ./scripts/start-server
   ```

4. **Configure CORS** in Zulip settings to allow embedding from mchsrobotics.dev

5. **Access at**: http://chat.mchsrobotics.dev

### Option C: Docker with Manual Fix

If you want to use Docker despite the SSL issues:

```bash
# 1. Stop and remove current container
cd /home/carter/Desktop/Website
docker compose down zulip

# 2. Pull Zulip Docker image manually
docker pull zulip/docker-zulip:10.0-0

# 3. Create a modified entrypoint that handles SSL properly
# (Requires advanced Docker knowledge)

# 4. For local dev, consider using Zulip Cloud instead
```

## Configuration

### Environment Variable (Optional)

Add `VITE_MATTERMOST_URL` to your environment to set a default Zulip server URL:

```bash
# In api/.env
VITE_MATTERMOST_URL=https://chat.mchsrobotics.dev
```

### Per-User Configuration

Users can configure their Zulip server URL via the chat header settings (gear icon) if the environment variable is not set.

## Migration from Custom Chat

The custom chat system has been replaced. Existing channels from your SQLite database:
- `#general` - Team-wide chatter
- `#announcements` - Important updates
- `#build` - Mechanical, electrical, fabrication
- `#programming` - Robot code, vision, software

You can recreate these in Zulip via the admin panel.

## Troubleshooting

**If Zulip doesn't load:**
- Check container status: `docker compose ps zulip`
- View logs: `docker compose logs zulip`
- Ensure port 8001 is not blocked

**CORS issues:**
- Zulip is configured to allow embedding by default
- Check Zulip settings at https://your-domain/admin/settings

## Getting Help

- Zulip Docs: https://zulip.readthedocs.io/
- Zulip Cloud: https://zulip.com/pricing/
- Docker image issue: https://github.com/zulip/docker-zulip/issues

## Alternative: Keep Current Chat System

If Zulip setup is too complex, you can keep the current custom chat system and just update the branding. The custom chat is fully functional with:
- Channels and messages
- Mentions and notifications
- Admin controls
- PWA support
