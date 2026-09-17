#!/bin/bash
echo "=== Generating Secure Tokens for WPLib ==="
echo ""

# Generate Robot API Key (64 chars, alphanumeric)
ROBOT_KEY=$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 64)
echo "ROBOT_API_KEY=$ROBOT_KEY"

# Generate JWT Secret (128 chars, alphanumeric + special)
JWT_SECRET=$(openssl rand -base64 96 | tr -d '\n/')
echo "JWT_SECRET=$JWT_SECRET"

# Generate SSH Key Pair for internal use (optional)
# echo ""
# echo "Generating internal SSH key pair..."
# ssh-keygen -t ed25519 -f ./ssh-keys/internal_key -N "" -C "wplib-internal" 2>/dev/null || true

echo ""
echo "=== Copy the above lines to your .env file ==="
