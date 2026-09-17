# SSH Public Key Setup for WPlib Remote Development
# =====================================================
# 
# To enable secure SSH access to the remote development environment:
#
# 1. Generate an SSH key (if you don't have one):
#    ssh-keygen -t ed25519 -C "wplib-dev"
#
# 2. Copy your public key:
#    cat ~/.ssh/id_ed25519.pub
#
# 3. Paste it into this file (one key per line):
#    ssh-ed25519 AAAA...your-key-here... user@host
#
# 4. Save this file and restart the Docker services:
#    docker-compose up -d ssh-server
#
# IMPORTANT: Only ed25519 keys are accepted for maximum security.
# The SSH server will only accept connections from authorized keys in this file.
