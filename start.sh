#!/bin/bash

# MCHS Robotics Website Startup Script
echo "🤖 Starting MCHS Robotics Website..."

cd ~/FIRST/Website

# Install dependencies if missing
if [ ! -d "node_modules" ] || [ ! -d "api/node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start both frontend and backend together
echo "🚀 Starting development servers..."
echo "   - Backend will run on http://localhost:3001"
echo "   - Frontend will run on http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

npm run dev:all
