# Docker-Based Development Environment

This setup isolates the coding/development workspace in a secure Docker container to eliminate permission errors and provide a consistent development environment.

## Architecture

The system uses **two separate containers**:

1. **`ssh-server` (wplib-ssh)** - Existing ultra-secure SSH server for robot deployment
2. **`dev-container` (jarvis-dev-workspace)** - New development container for VS Code Remote SSH

## Benefits of Docker Dev Container

✅ **No Permission Errors** - All files owned by `appuser` inside container
✅ **Consistent Environment** - Same Java, Node, Git versions everywhere
✅ **Isolated Workspace** - Each user gets their own sandboxed environment
✅ **Persistent Storage** - Workspaces survive container restarts via Docker volumes
✅ **VS Code Integration** - Connect via Remote SSH extension
✅ **Resource Limits** - Can set CPU/memory limits per container
✅ **Easy Cleanup** - Remove container without affecting host system

## Setup Instructions

### 1. Build and Start the Dev Container

```bash
# Build the dev container image
docker compose build dev-container

# Start only the dev container (doesn't affect other services)
docker compose up -d dev-container
```

### 2. Set Up SSH Access

```bash
# Generate SSH key if you don't have one
ssh-keygen -t ed25519 -f ~/.ssh/jarvis-dev -N ""

# Copy your public key to the container
docker compose exec dev-container sh -c "mkdir -p /home/appuser/.ssh && cat >> /home/appuser/.ssh/authorized_keys" < ~/.ssh/jarvis-dev.pub

# Set proper permissions
docker compose exec dev-container chmod 700 /home/appuser/.ssh
docker compose exec dev-container chmod 600 /home/appuser/.ssh/authorized_keys
docker compose exec dev-container chown -R appuser:appgroup /home/appuser/.ssh
```

### 3. Connect with VS Code

1. Install **Remote - SSH** extension in VS Code
2. Add new SSH host:
   ```
   Host jarvis-dev
     HostName localhost
     Port 2222
     User appuser
     IdentityFile ~/.ssh/jarvis-dev
   ```
3. Connect to `jarvis-dev`
4. Open folder `/home/appuser/workspace/Jarvis/dev/workspaces`

### 4. Access Your Workspace

Your code is stored in:
- **Inside container**: `/home/appuser/workspace/Jarvis/dev/workspaces`
- **Docker volume**: `jarvis-dev-workspace` (persistent)
- **Access from host**: `docker run --rm -it -v jarvis-dev-workspace:/data alpine ls /data`

## Updating the RemoteDevPage

Update the frontend to connect to the new container:

```javascript
// In RemoteDevPage.jsx, change API_BASE if needed
const API_BASE = '/api/remote-dev'; // Keep same, backend handles routing

// The backend now routes to the dev-container instead of ssh-server
```

## Backend Configuration

Update `/api/index.js` environment variables in docker-compose.yml:

```yaml
environment:
  - DEV_CONTAINER_HOST=dev-container
  - DEV_CONTAINER_SSH_PORT=2222
  - SSH_PRIVATE_KEY=/workspace/ssh-keys/id_ed25519
```

## Troubleshooting

### Check Container Status
```bash
docker compose ps dev-container
docker compose logs dev-container
```

### Restart Container
```bash
docker compose restart dev-container
```

### Access Container Shell
```bash
docker compose exec dev-container sh
```

### Reset Workspace Volume
⚠️ **Warning**: This deletes all workspace data!
```bash
docker compose down -v dev-container
docker volume rm workspace_dev-workspace
```

## Security Features

- ✅ Non-root user (`appuser`) runs all processes
- ✅ SSH key-only authentication (no passwords)
- ✅ Isolated network namespace
- ✅ No privileged access
- ✅ Read-only root filesystem option available
- ✅ Automatic security updates via base image

## Resource Limits (Optional)

Add to `docker-compose.yml` under `dev-container`:

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '0.5'
      memory: 512M
```

## Migration from Old System

If you were using the `ssh-server` for development:

1. Copy existing workspaces:
   ```bash
   docker run --rm -it \
     -v wplib_workspaces:/source \
     -v dev-workspace:/destination \
     alpine sh -c "cp -r /source/* /destination/"
   ```

2. Update your SSH config to point to port 2222 (dev-container) instead of the old SSH server

3. Test connection and verify files are accessible

## Next Steps

- [ ] Set up automated backups of workspace volume
- [ ] Configure multi-user support with separate containers per user
- [ ] Add pre-commit hooks in dev container
- [ ] Set up CI/CD pipeline integration
- [ ] Add monitoring and logging
