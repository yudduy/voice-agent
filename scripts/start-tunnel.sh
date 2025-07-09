#!/bin/bash
set -e

PORT=${PORT:-3000}
REGION=${NGROK_REGION:-us}

echo "🔧 Starting reliable ngrok tunnel..."
echo "📍 Port: $PORT"
echo "🌍 Region: $REGION"

# Kill any existing ngrok processes
echo "🧹 Cleaning up existing ngrok processes..."
pkill -f ngrok || echo "No existing ngrok processes found"

# Start ngrok in background
echo "🌐 Starting ngrok tunnel..."
ngrok http $PORT --region=$REGION &

# Wait for ngrok to start
echo "⏳ Waiting for ngrok to initialize..."
sleep 5

# Get the tunnel URL
echo "🔍 Retrieving tunnel URL..."
TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[0].public_url // empty')

if [ -z "$TUNNEL_URL" ]; then
    echo "❌ Failed to get tunnel URL"
    echo "💡 Make sure ngrok is properly configured with your authtoken:"
    echo "   ngrok config add-authtoken YOUR_TOKEN"
    exit 1
fi

echo "✅ Tunnel created: $TUNNEL_URL"

# Update .env file
ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
    # Remove existing WEBHOOK_BASE_URL line
    grep -v "^WEBHOOK_BASE_URL=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# Add new WEBHOOK_BASE_URL
echo "WEBHOOK_BASE_URL=$TUNNEL_URL" >> "$ENV_FILE"
echo "📝 Updated $ENV_FILE with new tunnel URL"

# Test the tunnel
echo "🔍 Testing tunnel connectivity..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TUNNEL_URL/health" || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Tunnel is working correctly!"
    echo ""
    echo "🎯 READY FOR VOICE TESTING:"
    echo "   Tunnel URL: $TUNNEL_URL"
    echo "   Local Server: http://localhost:$PORT"
    echo ""
    echo "🚀 Run your voice test:"
    echo "   node scripts/voice-test.js"
else
    echo "⚠️  Tunnel created but health check failed (HTTP $HTTP_CODE)"
    echo "💡 Make sure your local server is running on port $PORT"
    echo "   node src/app.js  # or npm start"
fi

echo ""
echo "ℹ️  To stop the tunnel: pkill -f ngrok" 