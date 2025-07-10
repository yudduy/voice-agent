#!/bin/bash

echo "🔄 Restarting Voice Server with Latest Fixes..."
echo "============================================"

# Kill any existing node processes running the app
echo "📍 Stopping existing server processes..."
pkill -f "node.*app.js" || true
pkill -f "node.*voice-test.js" || true

# Wait for processes to terminate
sleep 2

# Verify environment variables
echo ""
echo "📋 Verifying configuration:"
echo "BASE_URL: ${BASE_URL}"
echo "WEBHOOK_BASE_URL: ${WEBHOOK_BASE_URL}"
echo "AI_MAX_TOKENS: ${AI_MAX_TOKENS}"

# Start the server
echo ""
echo "🚀 Starting server with updated configuration..."
cd /Users/duy/Documents/build/caller
npm start &

# Wait for server to start
sleep 3

echo ""
echo "✅ Server restarted! The fixes are now active:"
echo "   - speechTimeout changed from 'auto' to 3 seconds"
echo "   - speechModel added to prevent XML validation errors"
echo "   - BASE_URL now matches WEBHOOK_BASE_URL for audio access"
echo "   - AI token limit increased to 500 to prevent cut-off responses"
echo ""
echo "🎯 You can now run: node scripts/voice-test.js"