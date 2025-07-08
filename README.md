# VERIES Caller (Voice AI Assistant)

Voice-first AI agent that:

* places outbound calls via **Twilio**,
* converses naturally using **Groq Whisper STT → OpenAI GPT-4o → ElevenLabs TTS** pipeline,
* stores long-term memory in **Supabase Postgres** and short-term context in **Upstash Redis**,
* logs every call/transcript with comprehensive monitoring.

---

## Voice Pipeline Architecture

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Speech-to-Text** | Groq Whisper v3 (primary) + Twilio STT (fallback) | High-accuracy transcription with recording |
| **Conversation AI** | OpenAI GPT-4o | Natural conversation with context awareness |
| **Text-to-Speech** | ElevenLabs (primary) + Hyperbolic (fallback) + Twilio (final) | Premium voice synthesis |
| **Telephony** | Twilio Programmable Voice + SMS | Call handling and webhooks |
| **Database** | Supabase Postgres | User profiles, call history, preferences |
| **Cache & Memory** | Upstash Redis | Real-time conversation state |
| **Monitoring** | Winston + Custom voice metrics | Comprehensive logging and debugging |

---

## Key Features

- **Real-time Voice Conversations**: Full duplex voice calls with natural AI responses
- **High-Quality Audio**: ElevenLabs TTS for premium voice synthesis
- **Accurate Transcription**: Groq Whisper v3 for superior speech recognition
- **Persistent Memory**: User profiles and conversation history in Supabase
- **Context Awareness**: Redis-backed short-term memory for fluid conversations
- **Fallback Systems**: Multiple TTS/STT providers ensure reliability
- **Comprehensive Testing**: End-to-end voice call integration tests
- **Production Ready**: Full webhook infrastructure with status monitoring

---

## Prerequisites

* Node 18+
* **Supabase** project (URL, anon key, **service_role** key)
* **Upstash Redis** REST URL & token
* **Twilio** account with voice-capable phone number
* **ElevenLabs** API key for high-quality TTS
* **Groq** API key for Whisper STT
* **OpenAI** API key for GPT-4o conversations
* Public HTTPS URL for webhooks (use **ngrok** for local dev)

---

## Quick Start

```bash
git clone <repo-url>
cd veries-caller
npm install
cp .env.example .env        # Fill in your API keys
node scripts/voice-test.js  # Test the voice pipeline
```

### Required Environment Variables

```env
# Twilio (Telephony)
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# Voice Pipeline
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=your_voice_id
GROQ_API_KEY=your_groq_key
OPENAI_API_KEY=your_openai_key

# Database & Cache
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# Webhooks (for local dev)
WEBHOOK_BASE_URL=https://your-ngrok-url.ngrok-free.app
TEST_PHONE=+19713364433
```

---

## Project Structure

```
src/
├─ app.js                   # Express server with webhook endpoints
├─ config/
│  ├─ ai.js                 # AI providers (OpenAI, Groq, ElevenLabs)
│  ├─ supabase.js           # Database client configuration
│  ├─ redis.js              # Cache client configuration
│  └─ telephony.js          # Twilio client setup
├─ services/
│  ├─ conversation.js       # OpenAI conversation handling
│  ├─ speechToText.js       # Groq Whisper STT integration
│  ├─ textToSpeech.js       # ElevenLabs TTS with fallbacks
│  ├─ caller.js             # Outbound call management
│  └─ cacheService.js       # Redis conversation memory
├─ webhooks/
│  └─ twilioWebhooks.js     # Voice call webhooks (/connect, /respond)
├─ repositories/            # Supabase data access layer
└─ utils/
   ├─ logger.js             # Winston-based logging
   └─ voiceMonitor.js       # Voice pipeline performance metrics

scripts/
├─ voice-test.js            # Main voice pipeline test
└─ setup-user.js            # Mock user account creation

logs/                       # Centralized application logs
```

---

## Testing the Voice Pipeline

### 1. Basic Voice Test
```bash
# Tests full Groq STT → OpenAI LLM → ElevenLabs TTS pipeline
node scripts/voice-test.js
```

This script:
- Creates a mock user in Supabase with all required database entries
- Places a real call to your test phone number
- Validates Groq STT transcription with recording enabled
- Tests OpenAI GPT-4o conversation responses
- Verifies ElevenLabs TTS generation and playback
- Monitors conversation state in Redis
- Logs all API calls and performance metrics

### 2. User Setup Utility
```bash
# Creates a mock user account for testing
node scripts/setup-user.js
```

---

## Supabase Database Schema

The application uses the following Supabase tables:

- **`auth.users`** - Core user authentication (managed by Supabase)
- **`phone_links`** - Phone number to user ID mapping
- **`user_profiles`** - Extended user information and onboarding status
- **`preferences`** - User voice and conversation preferences
- **`call_history`** - Complete call logs with transcripts and summaries
- **`sms_history`** - SMS conversation logs
- **`onboarding_messages`** - User onboarding workflow tracking

See `SUPABASE.md` for complete schema documentation.

---

## Voice Pipeline Monitoring

The system includes comprehensive logging for debugging voice calls:

### Real-time Logging
- **Groq STT**: Transcription accuracy, response times, audio processing
- **OpenAI LLM**: Token usage, response times, conversation context
- **ElevenLabs TTS**: Audio generation, caching, fallback usage
- **Twilio**: Call status, webhook events, recording URLs
- **Supabase**: Database operations, user state changes

### Log Files
- `logs/combined.log` - All application events
- `logs/error.log` - Error events only

### Performance Metrics
```javascript
// Access voice pipeline metrics
const voiceMonitor = require('./src/utils/voiceMonitor');
const metrics = voiceMonitor.getMetricsSummary();
```

---

## Production Deployment

### Webhook Configuration
Configure these endpoints in your Twilio Console:

- **Voice Webhook**: `POST https://your-domain.com/api/calls/connect`
- **Status Callback**: `POST https://your-domain.com/api/calls/status`
- **SMS Webhook**: `POST https://your-domain.com/webhooks/sms`

### Environment Setup
- Set `NODE_ENV=production`
- Use `SUPABASE_SERVICE_ROLE_KEY` for server operations
- Configure proper Redis connection pooling
- Enable webhook authentication for security

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|---------|
| **"RLS policy violation"** | Using anon key server-side | Use `SUPABASE_SERVICE_ROLE_KEY` |
| **ElevenLabs TTS fails** | Invalid API key or quota | Check API key, falls back to Hyperbolic/Twilio |
| **Groq STT not working** | Recording disabled or invalid key | Enable `ENABLE_RECORDING=true` and verify Groq key |
| **Webhook 404s** | Ngrok URL changed | Update `WEBHOOK_BASE_URL` and Twilio console |
| **Call history missing** | Status callback delays | Check Twilio webhook logs, increase polling time |

---

## Voice Quality Optimization

- **ElevenLabs**: Provides studio-quality voice synthesis
- **Groq Whisper v3**: Industry-leading speech recognition accuracy
- **Recording Enabled**: Allows Groq to process full audio for better transcription
- **Fallback Chain**: Ensures calls never fail due to single provider issues
- **Caching**: TTS audio cached to reduce latency on repeated phrases

---

## License

MIT © VERIES Team
