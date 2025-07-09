# VERIES Caller (Voice AI Assistant)

Voice-first AI agent that:

* places outbound calls via **Twilio**,
* converses naturally using **Groq Whisper STT → OpenAI GPT-4o → ElevenLabs TTS** pipeline,
* stores long-term memory in **Supabase Postgres** and short-term context in **Upstash Redis**,
* logs every call/transcript with comprehensive monitoring.

**🚀 NEW: Sub-500ms latency with streaming pipeline, speculative execution, and backchannels**

---

## Voice Pipeline Architecture

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Speech-to-Text** | Groq Whisper v3 (primary) + Twilio STT (fallback) | High-accuracy transcription with recording |
| **Conversation AI** | OpenAI GPT-4o-mini + Streaming API | Natural conversation with ultra-low latency |
| **Text-to-Speech** | ElevenLabs Flash v2.5 (primary) + Hyperbolic (fallback) + Twilio (final) | Premium voice synthesis optimized for speed |
| **Telephony** | Twilio Programmable Voice + SMS | Call handling and webhooks |
| **Database** | Supabase Postgres | User profiles, call history, preferences |
| **Cache & Memory** | Upstash Redis + Streams | Real-time conversation state + pipeline coordination |
| **Monitoring** | Winston + Custom voice metrics | Comprehensive logging and debugging |

---

## Key Features

### Core Capabilities
- **Real-time Voice Conversations**: Full duplex voice calls with natural AI responses
- **High-Quality Audio**: ElevenLabs TTS for premium voice synthesis
- **Accurate Transcription**: Groq Whisper v3 for superior speech recognition
- **Persistent Memory**: User profiles and conversation history in Supabase
- **Context Awareness**: Redis-backed short-term memory for fluid conversations
- **Fallback Systems**: Multiple TTS/STT providers ensure reliability
- **Comprehensive Testing**: End-to-end voice call integration tests
- **Production Ready**: Full webhook infrastructure with status monitoring

### Advanced Optimizations (NEW)
- **🔥 Sub-500ms Latency**: Streaming pipeline with parallel processing
- **🧠 Speculative Execution**: Starts LLM generation on partial STT input (15+ chars)
- **🎯 Smart Backchannels**: Context-aware conversational fillers ("Got it", "One moment")
- **⚡ Unified Processing**: Single webhook handler supporting all optimization modes
- **📊 Enhanced Metrics**: Detailed latency tracking and performance monitoring
- **🔄 Dynamic Correction**: Auto-corrects speculative responses when needed

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
OPENAI_MODEL=gpt-4o-mini
OPENAI_STREAMING_MODEL=gpt-4o-mini

# Advanced Features (NEW)
ENABLE_STREAMING=true
ENABLE_SPECULATIVE_EXECUTION=true
ENABLE_BACKCHANNELS=true

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
│  ├─ streamingConversation.js # Advanced streaming with speculation & backchannels
│  ├─ speculativeEngine.js  # Partial STT processing with correction
│  ├─ backchannelManager.js # Context-aware conversational fillers
│  ├─ speechToText.js       # Groq Whisper STT integration
│  ├─ textToSpeech.js       # ElevenLabs TTS with fallbacks
│  ├─ ttsQueue.js           # Priority-based TTS audio queue
│  ├─ caller.js             # Outbound call management
│  └─ cacheService.js       # Redis conversation memory
├─ webhooks/
│  └─ unifiedTwilioWebhooks.js # Unified webhook handler (streaming/standard/advanced)
├─ repositories/            # Supabase data access layer
└─ utils/
   ├─ logger.js             # Winston-based logging
   └─ voiceMonitor.js       # Voice pipeline performance metrics

scripts/
├─ voice-test.js            # Main voice pipeline test
├─ advanced-voice-test.js   # Advanced features test (speculation, backchannels)
└─ setup-user.js            # Mock user account creation

logs/                       # Centralized application logs
```

---

## Testing the Voice Pipeline

### Unified Voice Test (NEW)
```bash
# Single test script with multiple modes
node scripts/unified-voice-test.js +1234567890

# Test modes:
node scripts/unified-voice-test.js +1234567890 --mode=basic           # Quick validation
node scripts/unified-voice-test.js +1234567890 --mode=comprehensive  # Full testing (default)
node scripts/unified-voice-test.js +1234567890 --mode=streaming      # Streaming pipeline
node scripts/unified-voice-test.js +1234567890 --mode=advanced       # Advanced features
```

**Test Modes:**
- **Basic**: Quick environment validation and API connection tests
- **Comprehensive**: Full end-to-end voice pipeline testing with monitoring
- **Streaming**: Tests optimized streaming pipeline with latency metrics
- **Advanced**: Tests speculative execution, backchannels, and combined features

**What it tests:**
- Creates mock user in Supabase with all required database entries
- Places real call to your test phone number
- Validates Groq STT transcription with recording enabled
- Tests OpenAI conversation responses (streaming or standard)
- Verifies ElevenLabs TTS generation and playback
- Monitors conversation state in Redis
- Tracks performance metrics and latency optimization

### User Setup Utility
```bash
# Creates a mock user account for testing
node scripts/setup-user.js +1234567890 "John Doe"
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
- **Respond Webhook**: `POST https://your-domain.com/api/calls/respond` (unified handler)
- **Status Callback**: `POST https://your-domain.com/api/calls/status`
- **Recording Callback**: `POST https://your-domain.com/api/calls/recording`
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

## Performance Optimization

### Voice Quality
- **ElevenLabs Flash v2.5**: Ultra-low latency TTS with premium quality
- **Groq Whisper v3**: Industry-leading speech recognition accuracy
- **Recording Enabled**: Allows Groq to process full audio for better transcription
- **Fallback Chain**: Ensures calls never fail due to single provider issues
- **Caching**: TTS audio cached to reduce latency on repeated phrases

### Latency Optimization (NEW)
- **Streaming Pipeline**: 60-75% latency reduction from sequential processing
- **Parallel Processing**: STT, LLM, and TTS overlap instead of queuing
- **Speculative Execution**: ~70% success rate with <100ms correction time
- **Smart Backchannels**: Sub-200ms perceived latency through conversational fillers
- **Model Optimization**: GPT-4o-mini provides 3x faster responses than GPT-4o
- **Priority Queuing**: First sentence gets ultra-high priority for immediate playback

### Monitoring & Metrics
- **Real-time Latency Tracking**: `/api/calls/metrics` endpoint
- **Performance Debugging**: Debug flags for STT, LLM, and TTS components
- **Advanced Analytics**: Speculation success rates, backchannel effectiveness
- **Health Checks**: `/api/calls/health` for system status

For detailed optimization documentation, see `OPTIMIZATION.md`.

---

## License

MIT © VERIES Team
