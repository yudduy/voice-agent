# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VERIES Caller** is a sophisticated voice AI calling agent with a specific family mission - it's Duy trying to reach his older sister Zoey for homework help! Duy is the younger brother who constantly needs help with homework and other sibling stuff.

**Behavior**: The agent calls and asks "Hi this is Duy, is this Zoey?" If the person confirms they are Zoey, the agent gets demanding and slightly annoyed (typical younger sibling behavior) asking for help. If they say no or they're not Zoey, the agent politely says "Oh sorry, wrong number" and hangs up immediately.

**Personality**: When talking to Zoey, the agent acts like a frustrated younger brother who needs help - natural, conversational, slightly whiny/demanding but not mean. He asks for specific help with homework, projects, college advice, etc. Uses natural speech patterns with no weird abbreviations like "OMG".

**Voice Pipeline**: Twilio Media Streams → Deepgram Nova-2 STT → OpenAI GPT-4o-mini → ElevenLabs Turbo v2 TTS

**🎯 Current Status**: Production-ready with real-time streaming enabled. Features proper turn-taking, barge-in detection, and duplicate prevention. Duy/Zoey sibling dynamic with smart hangup logic for wrong numbers.

## Quick Start Commands

### Development
```bash
npm run dev        # Start with auto-reload
npm start          # Production server
npm test           # Run Jest tests
```

### Voice Pipeline Testing
```bash
# Main voice test (recommended)
node scripts/voice-test.js +1234567890

# Setup test user first
node scripts/setup-user.js +1234567890 "Test User"

# Test database connectivity
node scripts/database-test.js
```

### Individual Tests
```bash
npm test -- tests/services/conversation.test.js
npm test -- tests/repositories/userRepository.test.js
npm test -- --testNamePattern="specific test"
```

## Architecture

### Voice Pipeline (Real-time Streaming)
1. **Incoming Call** → Twilio → `/api/media-stream/connect` → WebSocket establishment
2. **Real-time Audio** → Twilio Media Streams → WebSocket → Deepgram Nova-2 STT
3. **Turn Management**:
   - Barge-in detection (stops agent when user speaks)
   - Speech end detection (500ms silence timeout)
   - Duplicate prevention (debouncing rapid STT results)
   - State tracking (isSpeaking, processingLLM flags)
4. **AI Processing** → OpenAI GPT-4o-mini → Redis context
5. **Speech Synthesis** → ElevenLabs TTS → FFmpeg transcoding → Twilio Media Stream
6. **Continuous bidirectional audio** with proper turn-taking and interruption handling

### Data Flow
- **Supabase**: User profiles, call history, preferences
- **Redis**: Real-time conversation state, call mappings
- **Local Cache**: TTS audio files (`/public/tts-cache/`)

### Active Components
- **Webhooks**: `mediaStreamWebhook.js` (WebSocket handler)
- **Orchestrator**: `websocketOrchestrator.js` (manages real-time pipeline)
- **Services**: `conversation.js`, `userRepository.js`
- **Real-time**: Deepgram WebSocket STT, ElevenLabs TTS, FFmpeg transcoding

## Key Files

### Core Services
- `src/services/conversation.js` - OpenAI conversation handling
- `src/services/speechToText.js` - Groq STT with Twilio fallback
- `src/services/textToSpeech.js` - ElevenLabs TTS with fallbacks
- `src/services/caller.js` - Outbound call management
- `src/services/cacheService.js` - Redis operations

### Configuration
- `src/config/ai.js` - AI models and prompts **⚠️ CRITICAL: NO SSML**
- `src/config/telephony.js` - Twilio settings
- `src/config/supabase.js` - Database client
- `src/config/redis.js` - Cache configuration

### Webhooks
- `src/webhooks/mediaStreamWebhook.js` - **ACTIVE** WebSocket handler for real-time audio
- `src/services/websocketOrchestrator.js` - Manages the entire real-time conversation flow
- `src/webhooks/smsWebhook.js` - SMS handling

## Environment Variables

### Required
```env
# Twilio
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+1234567890

# AI Services
OPENAI_API_KEY=your_key
GROQ_API_KEY=your_key
ELEVENLABS_API_KEY=your_key

# Database & Cache
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token

# Webhooks
WEBHOOK_BASE_URL=https://your-ngrok.ngrok-free.app
```

### Optional
```env
OPENAI_MODEL=gpt-4o-mini
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
TTS_PREFERENCE=elevenlabs
SPEECH_RECOGNITION_PREFERENCE=groq
```

## Critical Patterns

### ⚠️ SSML Prevention
**CRITICAL**: The AI must output PLAIN TEXT only. No SSML, XML, or special markup.

```javascript
// ✅ CORRECT
"Hello! I can help you with that."

// ❌ WRONG - CAUSES TWIML ERRORS
"Hello! <break time='1s'/> I can help you with that."
```

### Phone Number Format
Always use E.164 format: `+1234567890`

### Error Handling
```javascript
try {
  // operation
} catch (error) {
  logger.error('Operation failed:', error);
  // Fallback behavior
}
```

### Database Access
Always use service role key:
```javascript
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
```

## Common Tasks

### Debugging Voice Calls
1. Check `logs/combined.log` for pipeline details
2. Monitor TwiML generation for validation errors
3. Verify Redis conversation state
4. Test with `node scripts/voice-test.js +1234567890`

### Adding Voice Features
1. Update `src/services/conversation.js` for AI behavior
2. Modify system prompt (ensure NO SSML)
3. Test with voice pipeline script
4. Add unit tests

### Database Schema
Tables in `supabase/migrations/0001_initial_schema.sql`:
- `phone_links` - Phone to user mapping
- `user_profiles` - User information
- `call_history` - Call logs and transcripts
- `preferences` - User settings
- `sms_history` - SMS interactions

## Real-time Streaming Architecture

### Turn-Taking Management
The `websocketOrchestrator.js` implements sophisticated turn-taking:
- **Barge-in Detection**: When user speaks during agent response, immediately stops TTS
- **Speech End Detection**: 500ms silence timeout before processing final transcript
- **Duplicate Prevention**: Tracks last processed transcript and enforces minimum time between responses
- **State Management**: `isSpeaking`, `processingLLM`, and `currentResponseId` prevent race conditions

### WebSocket Connections
- **Twilio Media Stream**: Bidirectional audio transport
- **Deepgram STT**: Real-time transcription with VAD events
- **Turn Coordination**: Proper queueing and interruption handling

### Required Environment
```env
ENABLE_MEDIA_STREAMS=true
DEEPGRAM_API_KEY=your_key
```

## Testing Strategy

### Voice Pipeline Test
```bash
# Complete end-to-end test
node scripts/voice-test.js +1234567890

# This test:
# - Creates mock user in Supabase
# - Places real Twilio call
# - Tests STT → LLM → TTS pipeline
# - Validates conversation state
# - Monitors performance metrics
```

### Component Tests
```bash
npm test -- tests/services/conversation.test.js  # AI responses
npm test -- tests/services/textToSpeech.test.js  # TTS generation
npm test -- tests/webhooks/                      # Webhook handlers
```

## Performance Monitoring

### Voice Metrics
- TTS generation times and cache hits
- STT accuracy and latency
- LLM response times
- End-to-end call latency

### Logs
- `logs/combined.log` - All events
- `logs/error.log` - Errors only
- Voice pipeline events tagged with `category: 'voice'`

## Troubleshooting

### Common Issues
1. **Duplicate Responses**: Fixed with proper turn-taking and debouncing
2. **Audio Interruptions**: Barge-in detection now stops agent mid-speech
3. **Race Conditions**: State management prevents multiple concurrent LLM calls
4. **WebSocket Issues**: Ensure ENABLE_MEDIA_STREAMS=true and server restart
5. **Phone Format**: Use E.164 format (+1234567890)
6. **Webhook Connectivity**: Ensure ngrok tunnel active

### Debug Commands
```bash
# Test environment
node scripts/voice-test.js

# Check database
node scripts/database-test.js

# Monitor logs
tail -f logs/combined.log
```

This documentation reflects the current stable production state focused on reliable voice conversations without streaming optimizations that were causing audio interruption issues.