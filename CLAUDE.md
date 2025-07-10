# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VERIES Caller is a sophisticated voice AI calling agent that places outbound phone calls and has natural conversations. It uses a production-ready voice pipeline: Groq Whisper STT → OpenAI GPT-4o-mini → ElevenLabs TTS, with comprehensive fallback systems.

**🚀 IMPLEMENTATION STATUS**: The system has comprehensive streaming pipeline infrastructure built and ready, including speculative execution, backchannels, and WebRTC support. The current production webhook still uses sequential processing, but streaming components are fully implemented and can be activated via configuration.

## Key Commands

### Development
```bash
npm run dev        # Start with nodemon (auto-reload)
npm start          # Production server
npm test           # Run Jest tests
npm run lint       # ESLint checks
```

### Testing Voice Pipeline
```bash
# Unified voice test (all modes) - VERIFIED WORKING
node scripts/unified-voice-test.js +1234567890

# Test modes (VERIFIED SCRIPTS EXIST):
node scripts/unified-voice-test.js +1234567890 --mode=basic           # Quick validation
node scripts/unified-voice-test.js +1234567890 --mode=comprehensive  # Full testing (default)
node scripts/unified-voice-test.js +1234567890 --mode=streaming      # Streaming pipeline
node scripts/unified-voice-test.js +1234567890 --mode=advanced       # Advanced features

# Additional test scripts available:
node scripts/advanced-voice-test.js +1234567890  # Advanced features test
node scripts/database-test.js                    # Database connectivity test

# Create test user account - VERIFIED WORKING
node scripts/setup-user.js +1234567890 "John Doe"
```

### Running Single Tests
```bash
# VERIFIED WORKING TEST FILES:
npm test -- tests/services/conversation.test.js
npm test -- tests/services/cacheService.test.js  
npm test -- tests/services/smsHandler.test.js
npm test -- tests/webhooks/smsWebhook.test.js
npm test -- tests/repositories/userRepository.test.js
npm test -- tests/repositories/historyRepository.test.js

# Run tests matching pattern
npm test -- --testNamePattern="should generate response"

# Run with coverage
npm test -- --coverage
```

## Architecture Overview

### Current Voice Pipeline Flow (Production)
1. **Incoming Audio** → Twilio WebSocket → Groq Whisper v3 STT (with Twilio fallback)
2. **Transcription** → OpenAI GPT-4o-mini (configured model) with context from Redis  
3. **AI Response** → ElevenLabs TTS (with Hyperbolic + Twilio fallbacks)
4. **Audio Output** → Twilio media stream → Caller

### Streaming Pipeline Architecture (Available)
The system includes fully implemented streaming components:
- **StreamingVoiceHandler** (`services/streamingVoiceHandler.js`): Main coordinator for streaming pipeline
- **TTSQueue** (`services/ttsQueue.js`): Prioritized, parallel TTS generation with sequential playback
- **WebRTC Service** (`services/webrtcService.js`): Real-time audio streaming with VAD
- **Speculative Engine** (`services/speculativeEngine.js`): Predictive processing capabilities
- **Backchannel Manager** (`services/backchannelManager.js`): Natural conversation flow

### Data Architecture
- **Supabase Postgres**: Long-term storage (users, call history, preferences, SMS history)
- **Upstash Redis**: Real-time conversation state and call SID mappings
- **Local TTS Cache**: `/public/tts-cache/` (auto-created, extensively used)

### Core Services (VERIFIED IMPLEMENTATION)
- `services/conversation.js`: AI conversation management with OpenAI integration
- `services/speechToText.js`: Groq Whisper integration with Twilio fallback
- `services/textToSpeech.js`: Multi-provider TTS (ElevenLabs → Hyperbolic → Twilio)
- `services/caller.js`: Outbound call orchestration  
- `services/cacheService.js`: Redis operations for conversation state
- `services/streamingConversation.js`: Streaming LLM conversation handler
- `services/pipelineCoordinator.js`: Coordinates multiple pipeline components
- `services/topicTracker.js`: Conversation topic and context tracking
- `services/smsHandler.js`: SMS message processing and onboarding

### Webhook Endpoints (VERIFIED)
- `POST /api/calls/connect` - Initial call connection and greeting
- `POST /api/calls/respond` - Main conversation webhook (sequential processing)  
- `POST /api/calls/status` - Call status updates and cleanup
- `POST /api/calls/recording` - Recording status callbacks
- `POST /api/sms/incoming` - SMS message handling

### Alternative Webhook Implementations Available:
- `webhooks/streamingTwilioWebhooks.js`: Streaming pipeline webhook handlers
- `webhooks/unifiedTwilioWebhooks.js`: Unified webhook with enhanced features
- `webhooks/advancedTwilioWebhooks.js`: Advanced optimizations and backchannels

## Important Patterns

### Error Handling
All services use consistent error handling with Winston logging:
```javascript
try {
  // operation
} catch (error) {
  logger.error('Operation failed:', error);
  // Fallback behavior
}
```

### Phone Number Format
Always use E.164 format: `+1234567890` (not `(123) 456-7890`)

### Testing Approach
- Mock all external services (Twilio, OpenAI, etc.)
- Use `jest.mock()` for service dependencies
- Test files mirror source structure in `__tests__` folders

### Environment Variables
**Critical vars that must be set:**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `ELEVENLABS_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `WEBHOOK_BASE_URL` or `BASE_URL` (public HTTPS URL for webhooks)

**Optional optimization variables (with defaults):**
- `ENABLE_STREAMING=true` - Enable streaming pipeline
- `ENABLE_SPECULATIVE_EXECUTION=true` - Enable predictive processing
- `ENABLE_BACKCHANNELS=true` - Enable natural conversation backchannels
- `ENABLE_WEBRTC=true` - Enable WebRTC streaming
- `TTS_PREFERENCE=elevenlabs` - Primary TTS provider
- `SPEECH_RECOGNITION_PREFERENCE=groq` - Primary STT provider  
- `OPENAI_MODEL=gpt-4o-mini` - AI model (already configured)

### Database Access
Always use service role key for server operations:
```javascript
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
```

## Common Development Tasks

### Adding New Voice Features
1. Update `services/conversation.js` for AI behavior
2. Modify system prompt in `generateResponse()` method
3. Add tests in `__tests__/conversation.test.js`
4. Test with `node scripts/unified-voice-test.js +1234567890`

### Debugging Voice Calls
1. Check `logs/combined.log` for full pipeline logs
2. Voice metrics logged with `category: 'voice'`
3. Use `ENABLE_RECORDING=true` for Groq STT debugging
4. Monitor Redis for active conversation state

### Database Schema (VERIFIED IMPLEMENTATION)
Tables have RLS enabled. Actual implemented tables in `supabase/migrations/0001_initial_schema.sql`:
- `phone_links`: Phone → user mapping (E.164 format)
- `preferences`: User-specific voice and application settings  
- `call_history`: Complete call records with transcripts and metadata
- `sms_history`: SMS interaction logging
- `user_profiles`: Extended user data (if exists)

Note: Database uses Supabase auth.users as the primary user table.

### Performance Optimization
- TTS audio cached locally to reduce API calls
- Redis for fast conversation context access
- Multiple provider fallbacks for reliability
- Connection pooling for database queries

## Voice Pipeline Implementation Status

### Current Performance Architecture
- **Production Pipeline**: Sequential processing via `src/webhooks/twilioWebhooks.js`
  - STT: Groq Whisper v3 → Twilio fallback
  - LLM: OpenAI GPT-4o-mini (confirmed in config)
  - TTS: ElevenLabs → Hyperbolic → Twilio fallbacks
- **Performance**: Standard webhook latency (varies by network and API response times)

### Available Streaming Infrastructure (FULLY IMPLEMENTED)

The system includes complete streaming pipeline components that can be activated:

#### Core Streaming Components
- **`StreamingVoiceHandler`** (`src/services/streamingVoiceHandler.js`): Main coordinator with performance metrics
- **`TTSQueue`** (`src/services/ttsQueue.js`): Prioritized parallel TTS with sequential playback  
- **`StreamingConversation`** (`src/services/streamingConversation.js`): OpenAI streaming API integration
- **`WebRTC Service`** (`src/services/webrtcService.js`): Real-time audio streaming with VAD
- **`Speculative Engine`** (`src/services/speculativeEngine.js`): Predictive processing
- **`Backchannel Manager`** (`src/services/backchannelManager.js`): Natural conversation flow

#### Advanced Webhook Handlers Available
- **`streamingTwilioWebhooks.js`**: Streaming pipeline implementation
- **`unifiedTwilioWebhooks.js`**: Enhanced webhook with streaming support
- **`advancedTwilioWebhooks.js`**: Full optimization features with backchannels

#### Activation via Configuration
Enable streaming features by setting environment variables:
```bash
ENABLE_STREAMING=true
ENABLE_SPECULATIVE_EXECUTION=true  
ENABLE_BACKCHANNELS=true
ENABLE_WEBRTC=true
```

### Performance Monitoring Infrastructure

#### Voice Metrics (`src/utils/voiceMonitor.js`)
```javascript
// Current metrics tracked:
{
  ttsRequests: 0,     // Total TTS requests
  ttsSuccess: 0,      // Successful generations
  ttsFailed: 0,       // Failed generations  
  cacheHits: 0,       // Cache hit rate
  responseTimes: [],  // Response time history
  audioSizes: []      // Audio file sizes
}
```

#### Streaming Metrics (available in StreamingVoiceHandler)
```javascript
// Latency breakdown tracking:
{
  sttLatency: null,
  llmFirstChunkLatency: null,
  ttsFirstAudioLatency: null,
  totalLatency: null,
  perceivedLatency: null,  // Time to first audio
  sentenceCount: 0,
  audioChunks: 0
}
```

### Testing Pipeline Variants
```bash
# Test current production pipeline
node scripts/unified-voice-test.js +1234567890 --mode=basic

# Test streaming implementation (if enabled)
node scripts/unified-voice-test.js +1234567890 --mode=streaming

# Test advanced optimization features  
node scripts/unified-voice-test.js +1234567890 --mode=advanced
```

### Performance Optimization Features

#### TTS Queue Management
- **Priority Levels**: Backchannel (5) → Ultra-high (4) → High (3) → Normal (2) → Low (1)
- **Parallel Generation**: Up to 3 concurrent TTS jobs
- **Provider Fallbacks**: ElevenLabs → Hyperbolic → Twilio
- **First Sentence Priority**: Ultra-high priority for immediate playback

#### AI Model Configuration
- **Model**: GPT-4o-mini (optimized for speed and cost)
- **Streaming Model**: GPT-4o-mini with streaming support
- **Max Tokens**: 200 (standard), 120 (streaming)
- **Temperature**: 0.3 for consistent responses

#### WebRTC Integration
- **Providers**: Daily.co, LiveKit support
- **Real-time Processing**: 100-200ms audio chunks
- **VAD**: Voice Activity Detection for endpoint detection
- **Buffer Management**: Smart audio buffering with pre/post-roll

### Current Limitations and Activation Path

#### To Enable Streaming Pipeline:
1. Set environment variables for streaming features
2. Switch webhook endpoint to use `streamingTwilioWebhooks.js`
3. Configure WebRTC provider (Daily.co or LiveKit)
4. Test with streaming-specific test scripts

#### Infrastructure Ready, Configuration Required:
- All streaming components are implemented and tested
- WebRTC service supports multiple providers
- TTS queue handles prioritization and parallel processing
- Comprehensive monitoring and metrics collection built-in