#!/bin/bash
# Sandbox script for wplib-dev user - blocks all internet access while allowing local communication
# Run this on your DietPi server as root

echo "Setting up network sandbox for wplib-dev user..."

# Block ALL outgoing internet traffic from wplib-dev user
# This prevents any escape attempts via HTTP, HTTPS, SSH, etc.
iptables -A OUTPUT -m owner --uid-owner wplib-dev -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner wplib-dev -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner wplib-dev -j DROP

# Block incoming traffic to wplib-dev except from localhost
iptables -A INPUT -m owner --uid-owner wplib-dev ! -s 127.0.0.0/8 -j DROP

echo "✓ Network sandbox applied:"
echo "  - wplib-dev can only communicate with localhost (127.0.0.0/8)"
echo "  - wplib-dev can only communicate with local network (10.0.0.0/8) for robot"
echo "  - All other internet access is BLOCKED"
echo ""
echo "To verify, run as wplib-dev user:"
echo "  sudo -u wplib-dev ping google.com (should fail)"
echo "  sudo -u wplib-dev curl https://google.com (should fail)"
echo "  sudo -u wplib-dev curl http://localhost:3001/health (should work)"
