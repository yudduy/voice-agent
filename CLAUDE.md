# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VERIES Caller is a sophisticated voice AI calling agent that places outbound phone calls and has natural conversations. It uses a production-ready voice pipeline: Groq Whisper STT → OpenAI GPT-4o-mini → ElevenLabs TTS, with comprehensive fallback systems.

**🚀 MAJOR UPDATE**: The system now supports sub-500ms latency through streaming pipeline, speculative execution, and backchannels - achieving 60-75% latency reduction from the original architecture.

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
# Unified voice test (all modes)
node scripts/unified-voice-test.js +1234567890

# Test modes:
node scripts/unified-voice-test.js +1234567890 --mode=basic           # Quick validation
node scripts/unified-voice-test.js +1234567890 --mode=comprehensive  # Full testing (default)
node scripts/unified-voice-test.js +1234567890 --mode=streaming      # Streaming pipeline
node scripts/unified-voice-test.js +1234567890 --mode=advanced       # Advanced features

# Create test user account
node scripts/setup-user.js +1234567890 "John Doe"
```

### Running Single Tests
```bash
# Run specific test file
npm test -- src/services/__tests__/conversation.test.js

# Run tests matching pattern
npm test -- --testNamePattern="should generate response"

# Run with coverage
npm test -- --coverage
```

## Architecture Overview

### Voice Pipeline Flow
1. **Incoming Audio** → Twilio WebSocket → Groq Whisper v3 STT (with Twilio fallback)
2. **Transcription** → OpenAI GPT-4o with context from Redis
3. **AI Response** → ElevenLabs TTS (with Hyperbolic + Twilio fallbacks)
4. **Audio Output** → Twilio media stream → Caller

### Data Architecture
- **Supabase Postgres**: Long-term storage (users, call history, preferences)
- **Upstash Redis**: Real-time conversation state and active call context
- **Local Cache**: TTS audio files in `/public/tts-cache/`

### Core Services
- `services/conversation.js`: AI conversation management with topic tracking
- `services/speechToText.js`: Groq integration with fallback handling
- `services/textToSpeech.js`: Multi-provider TTS with caching
- `services/caller.js`: Outbound call orchestration
- `services/cacheService.js`: Redis operations for conversation state

### Webhook Endpoints
- `POST /voice/incoming` - Handles incoming calls
- `POST /voice/stream` - WebSocket audio streaming
- `POST /voice/status` - Call status updates
- `POST /sms/incoming` - SMS message handling
- `POST /voice/gather` - DTMF input collection

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
Critical vars that must be set:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `ELEVENLABS_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `WEBHOOK_BASE_URL` (public HTTPS URL for webhooks)

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

### Database Migrations
Tables have RLS enabled. Key tables:
- `phone_links`: Phone → user mapping
- `user_profiles`: Extended user data
- `call_history`: Full call transcripts
- `preferences`: Voice settings

### Performance Optimization
- TTS audio cached locally to reduce API calls
- Redis for fast conversation context access
- Multiple provider fallbacks for reliability
- Connection pooling for database queries

## Voice Pipeline Latency Optimization

### Current Performance Baseline
- **Total latency**: 1000-2000ms (STT: 200-400ms, LLM: 500-1000ms, TTS: 300-600ms)
- **Architecture**: Sequential processing (STT → LLM → TTS)
- **Primary bottleneck**: `/respond` webhook in `src/webhooks/twilioWebhooks.js` (lines 130-260)

### Optimization Target Architecture
Based on research from Muhammad Usman Bashir (239ms achievement) and industry best practices:

#### Streaming Pipeline (Target: Sub-500ms)
```
Current:  User speaks (2000ms) → STT (300ms) → LLM (800ms) → TTS (500ms) = 3600ms
Optimized: User speaks chunk 1 (200ms) → STT (100ms) → LLM starts (100ms) → TTS starts (200ms) = 500ms perceived
```

#### Key Optimization Strategies
1. **Parallel Processing**: STT, LLM, TTS overlap instead of sequential
2. **Sentence-Level Chunking**: Start TTS immediately when first sentence is complete
3. **Model Optimization**: GPT-4o → GPT-4o-mini (3x faster, cheaper)
4. **WebRTC Streaming**: Replace Twilio recording downloads with real-time audio chunks

### Critical Files for Optimization

#### High Impact Changes
- **`src/webhooks/twilioWebhooks.js`** (lines 130-260): Replace sequential processing with streaming pipeline
- **`src/services/conversation.js`** (lines 60-120): Implement OpenAI streaming API
- **`src/services/textToSpeech.js`**: Add TTS queue management with sentence chunking
- **`src/config/ai.js`**: Switch to gpt-4o-mini, add ElevenLabs Flash v2.5

#### New Components Needed
- **`src/services/streamingVoiceHandler.js`**: Coordinated streaming pipeline
- **`src/services/ttsQueue.js`**: Priority-based audio generation queue  
- **`src/services/webrtcService.js`**: Real-time audio streaming (Phase 2)

### Implementation Phases

#### Phase 1: Streaming Implementation (40-60% improvement)
```bash
# Test streaming LLM implementation
node scripts/voice-test.js +1234567890
# Monitor logs for latency breakdown: STT: Xms, LLM: Yms, TTS: Zms
```

Key changes:
- Streaming OpenAI API with sentence detection
- TTS queue with ultra-high priority for first sentence
- Parallel audio generation with sequential playback

#### Phase 2: WebRTC Integration (60-75% improvement)  
- Replace Twilio recording URLs with Daily.co WebRTC streaming
- Process 100-200ms audio chunks instead of complete files
- Voice Activity Detection (VAD) for better endpoint detection

### Performance Monitoring

#### Latency Metrics to Track
```javascript
// Add to existing voiceMonitor.js
{
  sttLatency: 150,        // Target: <200ms
  llmLatency: 300,        // Target: <400ms  
  ttsLatency: 200,        // Target: <300ms
  totalLatency: 650,      // Target: <500ms
  firstResponseTime: 450, // Target: <400ms (perceived latency)
  chunksProcessed: 3,
  fallbacksUsed: 0
}
```

#### Testing Optimization
```bash
# Measure baseline performance
node scripts/unified-voice-test.js +1234567890 --mode=basic

# Test streaming implementation  
node scripts/unified-voice-test.js +1234567890 --mode=streaming

# Test advanced features
node scripts/unified-voice-test.js +1234567890 --mode=advanced
```

### Cost Optimization Focus

#### Free/Generous Tier Services
- **Groq STT**: Maintain as primary (generous free tier)
- **GPT-4o-mini**: Switch from GPT-4o (3x speed, much cheaper)
- **Daily.co**: WebRTC streaming (free tier available)
- **Smart caching**: Reduce API calls through intelligent buffering

#### Configuration for Cost Efficiency
```javascript
// src/config/ai.js optimizations
openAI: {
  model: 'gpt-4o-mini',     // Switch from gpt-4o
  maxTokens: 100,           // Reduce from 200
  temperature: 0.3,         // More consistent responses
  stream: true              // Enable streaming
}
```

### Debugging Latency Issues

#### Performance Profiling
```bash
# Enable detailed latency logging
DEBUG_LATENCY=true node scripts/unified-voice-test.js +1234567890 --mode=streaming

# Monitor specific components
DEBUG_STT=true DEBUG_LLM=true DEBUG_TTS=true npm run dev
```

#### Common Bottlenecks
1. **Groq STT file downloads**: Check network latency to Groq servers
2. **OpenAI response times**: Monitor token generation speed
3. **ElevenLabs TTS**: Check audio generation queue depth
4. **Redis operations**: Monitor conversation state access times
5. **Twilio webhooks**: Check round-trip times to webhook server

### Fallback Strategy During Optimization
Always maintain existing fallback chains during optimization:
- **STT**: Groq → Twilio fallback  
- **TTS**: ElevenLabs → Hyperbolic → Twilio fallback
- **Webhook responses**: Always return valid TwiML even on errors
- **Conversation state**: Graceful degradation if Redis unavailable

### Success Criteria
- **Phase 1**: First audio playback starts <800ms (down from 1500ms+)
- **Phase 2**: Total perceived latency <500ms
- **Quality**: Maintain ElevenLabs voice quality and conversation coherence  
- **Reliability**: 99%+ success rate with graceful fallbacks
- **Cost**: Stay within free tier limits during development