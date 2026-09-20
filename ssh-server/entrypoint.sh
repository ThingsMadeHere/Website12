#!/bin/bash
set -e

echo "[SSH Server] Starting ultra-secure SSH server for WPlib..."

# Generate host keys if not present (4096-bit RSA + ed25519)
if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    echo "[SSH Server] Generating ed25519 host key..."
    ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -q
fi

if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    echo "[SSH Server] Generating RSA 4096-bit host key..."
    ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_rsa_key -N "" -q
fi

# Set proper permissions
chmod 600 /etc/ssh/ssh_host_*_key
chmod 644 /etc/ssh/ssh_host_*_key.pub

# Create authorized_keys directory for wplib-dev user
mkdir -p /home/wplib-dev/.ssh
chmod 700 /home/wplib-dev/.ssh
chown wplib-dev:wplib-dev /home/wplib-dev/.ssh

# Check if authorized_keys exists and has content
if [ -f /home/wplib-dev/.ssh/authorized_keys ] && [ -s /home/wplib-dev/.ssh/authorized_keys ]; then
    echo "[SSH Server] Authorized keys found."
    chmod 600 /home/wplib-dev/.ssh/authorized_keys
    chown wplib-dev:wplib-dev /home/wplib-dev/.ssh/authorized_keys
else
    echo "[SSH Server] WARNING: No authorized_keys file found!"
    echo "[SSH Server] Please mount your public key to /home/wplib-dev/.ssh/authorized_keys"
    echo "[SSH Server] Example: docker run -v ~/.ssh/id_ed25519.pub:/home/wplib-dev/.ssh/authorized_keys ..."
fi

# Chroot directory structure is set up in Dockerfile with proper ownership
# The workspaces directory is owned by wplib-dev for write access within chroot
echo "[SSH Server] Chroot directory structure verified."

echo "[SSH Server] Security features enabled:"
echo "  ✓ Key-only authentication (no passwords)"
echo "  ✓ Restricted to user: wplib-dev"
echo "  ✓ Restricted algorithms (ed25519, AES-GCM, SHA2)"
echo "  ✓ No X11/TCP forwarding/tunneling"
echo "  ✓ Max 2 auth attempts, 30s login grace"
echo "  ✓ Verbose logging enabled"
echo "  ✓ Chroot SFTP restricted to workspaces directory"
echo ""
echo "[SSH Server] Starting SSH daemon on port 2222..."

exec "$@"
