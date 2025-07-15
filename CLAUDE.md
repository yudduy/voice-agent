# CLAUDE.md

Technical documentation for Claude Code assistance with the Voice AI Assistant project.

## Project Overview

**Voice AI Assistant** is a professional voice-first AI calling system designed for intelligent outbound calling campaigns. The system provides real-time voice processing, conversation management, and enterprise-grade scalability.

**Core Technology Stack**: Twilio Voice API → Deepgram STT → OpenAI GPT → ElevenLabs TTS

**Production Status**: Fully operational with real-time streaming, advanced barge-in handling, and comprehensive conversation management.

## Quick Start Commands

### Development
```bash
npm run dev        # Start with auto-reload
npm start          # Production server
npm test           # Run Jest tests
npm run lint       # Code quality checks
```

### Voice Pipeline Testing
```bash
# Primary voice pipeline test
node scripts/voice-test.js +1234567890

# Component testing
node scripts/test-streaming.js              # Test streaming components
node scripts/test-streaming.js elevenlabs   # Test ElevenLabs WebSocket
node scripts/test-streaming.js openai       # Test OpenAI streaming

# User setup and database testing
node scripts/setup-user.js +1234567890 "Test User"
node scripts/database-test.js
```

### Test Suite
```bash
npm test -- tests/services/conversation.test.js
npm test -- tests/repositories/userRepository.test.js
npm test -- tests/services/websocketOrchestrator.test.js
npm test -- tests/services/elevenLabsStream.test.js
npm test -- tests/services/audioCache.test.js
npm test -- tests/services/textToSpeech.test.js
npm test -- tests/services/speechToText.test.js
npm test -- tests/webhooks/mediaStreamWebhook.test.js
```

## Architecture

### Voice Pipeline (Real-time Streaming)
1. **Call Initiation** → Twilio → `/api/media-stream/connect` → WebSocket establishment
2. **Audio Processing** → Twilio Media Streams → WebSocket → Deepgram Nova-3 STT
3. **Conversation Management**:
   - Intelligent barge-in detection with grace periods
   - Speech end detection (700ms silence timeout)
   - Duplicate prevention through transcript debouncing
   - Multi-state tracking (speaking, processing, interruption flags)
   - Context-aware conversation flow management
4. **AI Processing**:
   - Intent classification and response generation
   - Context-aware prompt building
   - Response validation and quality control
   - OpenAI GPT-4 → Redis context management (30 turn history)
5. **Audio Synthesis** → ElevenLabs TTS → FFmpeg transcoding → Twilio Media Stream
6. **Continuous Communication** with intelligent turn-taking and interruption handling

### Data Storage
- **Supabase PostgreSQL**: User profiles, call history, conversation logs
- **Redis**: Real-time conversation state, call session mapping
- **Local Cache**: TTS audio files (`/public/tts-cache/`)

### Core Components
- **Webhooks**: 
  - `mediaStreamWebhook.js` - Primary WebSocket handler for real-time audio
  - `twilioWebhookManager.js` - Webhook configuration management
- **Orchestrator**: `websocketOrchestrator.js` - Central conversation flow management
- **Services**: 
  - `conversation.js` - AI conversation processing with context management
  - `cacheService.js` - Redis operations with intelligent caching
  - `speechToText.js` - STT processing and fallback handling
  - `textToSpeech.js` - TTS generation with multi-provider support
- **Real-time Processing**: 
  - Deepgram WebSocket STT with Voice Activity Detection
  - ElevenLabs TTS with streaming capabilities
  - FFmpeg transcoding with proper interruption handling

## Key Configuration Files

### Core Services
- `src/services/conversation.js` - AI conversation management with intent processing
- `src/services/websocketOrchestrator.js` - Real-time conversation orchestration
- `src/services/speechToText.js` - Speech recognition with fallback providers
- `src/services/textToSpeech.js` - Multi-provider TTS with caching
- `src/services/caller.js` - Outbound call management
- `src/services/cacheService.js` - Redis operations with performance optimization

### Configuration
- `src/config/ai.js` - AI models and conversation parameters
- `src/config/telephony.js` - Twilio settings and phone configuration
- `src/config/supabase.js` - Database client configuration
- `src/config/redis.js` - Cache configuration with connection pooling

### Webhooks
- `src/webhooks/mediaStreamWebhook.js` - Primary real-time audio handler
- `src/webhooks/unifiedTwilioWebhooks.js` - Legacy batch processing fallback
- `src/webhooks/smsWebhook.js` - SMS message handling
- `src/services/twilioWebhookManager.js` - Dynamic webhook configuration

## Environment Variables

### Required Configuration
```env
# Twilio Voice API
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# AI Services
OPENAI_API_KEY=your_openai_key
DEEPGRAM_API_KEY=your_deepgram_key
ELEVENLABS_API_KEY=your_elevenlabs_key
GROQ_API_KEY=your_groq_key

# Database & Cache
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# Application
WEBHOOK_BASE_URL=https://your-domain.ngrok-free.app
ENABLE_MEDIA_STREAMS=true
```

### Optional Configuration
```env
OPENAI_MODEL=gpt-4-turbo
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
TTS_PREFERENCE=elevenlabs
SPEECH_RECOGNITION_PREFERENCE=deepgram
ENABLE_RESPONSE_CACHING=true
RESPONSE_CACHE_TTL=3600
ENABLE_SPECULATIVE_TTS=true
```

## Development Patterns

### Error Handling
```javascript
try {
  // Operation
} catch (error) {
  logger.error('Operation failed:', error);
  // Graceful fallback
}
```

### Phone Number Format
Always use E.164 format: `+1234567890`

### Database Access
```javascript
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
```

## Common Development Tasks

### Voice Pipeline Debugging
1. Monitor `logs/combined.log` for pipeline events
2. Search for `[DEBUG-STATE]`, `[DEBUG-AUDIO]`, `[DEBUG-TRANSCRIPT]` tags
3. Check WebSocket connections and Deepgram events
4. Verify Redis conversation state
5. Test with `node scripts/voice-test.js +1234567890`

### Adding Voice Features
1. Update conversation parameters in `src/config/ai.js`
2. Modify intent classification in `src/services/conversation.js`
3. Update response handling logic as needed
4. Adjust turn-taking parameters in `websocketOrchestrator.js`
5. Add comprehensive unit tests
6. Test with voice pipeline scripts

### Database Schema
Tables in `supabase/migrations/0001_initial_schema.sql`:
- `phone_links` - Phone number to user mapping
- `user_profiles` - User information and preferences
- `call_history` - Call logs and transcripts
- `preferences` - User-specific settings
- `sms_history` - SMS interaction logs

## Real-time Streaming Architecture

### Advanced Turn-Taking
The `websocketOrchestrator.js` implements sophisticated conversation management:
- **Intelligent Barge-in**: Detects user speech during assistant responses
- **Speech End Detection**: 700ms silence timeout for natural conversation flow
- **Duplicate Prevention**: Transcript debouncing with 1200ms minimum intervals
- **State Management**: Multiple flags prevent race conditions:
  - `isSpeaking` - Assistant currently speaking
  - `isUserSpeaking` - User currently speaking
  - `processingLLM` - AI request in progress
  - `currentResponseId` - Response tracking
- **Context Preservation**: Maintains conversation continuity

### WebSocket Infrastructure
- **Twilio Media Stream**: Bidirectional audio transport (mulaw 8kHz)
- **Deepgram STT**: Real-time transcription with:
  - Voice Activity Detection (VAD) events
  - UtteranceEnd detection for robust turn-taking
  - Interim and final transcripts
  - Configurable endpointing (450ms default)
- **Turn Coordination**: Intelligent queueing and interruption management

### Advanced Features
- **Context-Aware Processing**: Maintains conversation history and user state
- **Intent Classification**: Recognizes conversation patterns and user needs
- **Response Validation**: Ensures appropriate and helpful responses
- **Performance Optimization**: Intelligent caching and resource management

## Testing Strategy

### Complete Pipeline Testing
```bash
# End-to-end voice pipeline test
node scripts/voice-test.js +1234567890

# Test includes:
# - User creation in Supabase
# - Live Twilio call placement
# - STT → AI → TTS pipeline validation
# - Conversation state verification
# - Performance metric collection
```

### Component Testing
```bash
npm test -- tests/services/conversation.test.js  # AI response testing
npm test -- tests/services/textToSpeech.test.js  # TTS generation
npm test -- tests/webhooks/                      # Webhook handlers
npm test -- tests/services/                      # Service layer tests
```

## Performance Monitoring

### Voice Pipeline Metrics
- TTS generation latency and cache performance
- STT accuracy and processing time
- AI response generation time
- End-to-end call latency measurements

### Logging Infrastructure
- `logs/combined.log` - Comprehensive event logging
- `logs/error.log` - Error-specific logging
- Structured logging with voice pipeline categorization

## Common Issues & Solutions

### Performance Issues
1. **Audio Latency**: Optimize with streaming TTS and response caching
2. **Memory Usage**: Monitor WebSocket connections and implement proper cleanup
3. **Concurrent Calls**: Ensure proper resource pooling and state isolation

### Development Issues
1. **WebSocket Connectivity**: Verify ENABLE_MEDIA_STREAMS=true and restart server
2. **Phone Number Format**: Always use E.164 format (+1234567890)
3. **Webhook Setup**: Ensure ngrok tunnel is active and properly configured
4. **Environment Variables**: Validate all required configuration is present

### Debug Commands
```bash
# Environment validation
node scripts/voice-test.js

# Database connectivity
node scripts/database-test.js

# Real-time log monitoring
tail -f logs/combined.log | grep "voice"
```

## Recent Improvements

### Streaming Performance Enhancement
1. **Real-time Audio Pipeline** - Optimized OpenAI Stream → ElevenLabs WebSocket flow
2. **WebSocket Integration** - Direct streaming without REST API overhead
3. **Latency Reduction** - Audio playback begins during AI generation
4. **Interruption Handling** - Clean stop of all streaming processes during barge-in

### Conversation Intelligence
1. **Enhanced Context Management** - Improved conversation history handling
2. **Intent Classification** - Advanced user intent recognition
3. **Response Quality** - Validation and improvement of AI responses
4. **Context Window Optimization** - Increased to 30 conversation turns
5. **Smart Caching** - Intelligent response caching with context awareness

### Architecture Improvements
1. **Connection Pooling** - Optimized resource management
2. **Error Handling** - Enhanced error recovery and logging
3. **Performance Monitoring** - Comprehensive metrics and alerting
4. **Security Hardening** - Improved credential management and validation

This documentation reflects the current production-ready state of the Voice AI Assistant system with enterprise-grade features and professional implementation standards.