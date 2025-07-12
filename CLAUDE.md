# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VERIES Caller** is a sophisticated voice AI calling agent designed for scam detection and prevention training. The current implementation simulates "Ben from Microsoft Support" - a common tech support scam scenario.

**⚠️ IMPORTANT**: This is for educational and security awareness purposes only. The system is designed to help identify and understand scam tactics.

**Current Persona**: Ben, a "Microsoft Support" agent who claims to have detected a virus on the user's computer. The goal is to demonstrate common scam tactics including urgency creation, technical jargon, and attempts to obtain payment information.

**Behavior**: The agent follows a multi-step scam script:
1. Initial contact claiming to be from Microsoft Support
2. Creating urgency about a "dangerous virus"
3. Pitching a paid "Network Security Firewall" solution ($299)
4. Attempting to collect credit card information

**Voice Pipeline**: Twilio Media Streams → Deepgram Nova-2 STT → OpenAI GPT-4o-mini → ElevenLabs Turbo v2 TTS

**🎯 Current Status**: Production-ready with real-time streaming enabled. Features proper turn-taking, barge-in detection, and duplicate prevention. Enhanced conversation awareness to prevent repetitive loops. The codebase has been fully updated to use the "Ben from Microsoft Support" persona consistently.

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

# Test streaming components
node scripts/test-streaming.js              # Test all streaming components
node scripts/test-streaming.js elevenlabs   # Test ElevenLabs WebSocket only
node scripts/test-streaming.js openai       # Test OpenAI streaming only

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
   - Speech end detection (700ms silence timeout)
   - Duplicate prevention (debouncing rapid STT results)
   - State tracking (isSpeaking, processingLLM flags)
   - Pattern detection to prevent repetitive loops
4. **AI Processing**:
   - User intent classification (confusion, scam responses, etc.)
   - Context-aware prompt generation
   - Response validation to maintain persona
   - OpenAI GPT-4o-mini → Redis context (30 turn history)
5. **Speech Synthesis** → ElevenLabs TTS → FFmpeg transcoding → Twilio Media Stream
6. **Continuous bidirectional audio** with proper turn-taking and interruption handling

### Data Flow
- **Supabase**: User profiles, call history, preferences
- **Redis**: Real-time conversation state, call mappings
- **Local Cache**: TTS audio files (`/public/tts-cache/`)

### Active Components
- **Webhooks**: 
  - `mediaStreamWebhook.js` - WebSocket handler for real-time audio
  - `twilioWebhookManager.js` - Manages webhook configuration
- **Orchestrator**: `websocketOrchestrator.js` - Central component managing the entire real-time conversation flow
- **Services**: 
  - `conversation.js` - AI conversation handling with intent classification
  - `cacheService.js` - Redis operations with response caching
  - `speechToText.js` - STT fallback handling
  - `textToSpeech.js` - TTS generation with caching
- **Real-time Components**: 
  - Deepgram WebSocket STT with VAD events
  - ElevenLabs TTS with streaming support
  - FFmpeg transcoding with barge-in handling

## Key Files

### Core Services
- `src/services/conversation.js` - AI conversation with intent classification and response validation
- `src/services/websocketOrchestrator.js` - Real-time conversation flow management
- `src/services/speechToText.js` - STT service (Groq/Twilio - used in batch mode only)
- `src/services/textToSpeech.js` - ElevenLabs TTS with caching
- `src/services/caller.js` - Outbound call management
- `src/services/cacheService.js` - Redis operations with enhanced response caching

### Configuration
- `src/config/ai.js` - AI models and system prompt (Ben from Microsoft Support persona) **⚠️ CRITICAL: NO SSML**
- `src/config/telephony.js` - Twilio settings
- `src/config/supabase.js` - Database client
- `src/config/redis.js` - Cache configuration with connection pooling

### Webhooks
- `src/webhooks/mediaStreamWebhook.js` - **PRIMARY** WebSocket handler for real-time audio streaming
- `src/webhooks/unifiedTwilioWebhooks.js` - Legacy batch processing (fallback when streaming disabled)
- `src/webhooks/smsWebhook.js` - SMS handling
- `src/services/twilioWebhookManager.js` - Dynamic webhook configuration switching

## Environment Variables

### Required
```env
# Twilio
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+1234567890

# AI Services
OPENAI_API_KEY=your_key
DEEPGRAM_API_KEY=your_key  # Required for streaming
ELEVENLABS_API_KEY=your_key
GROQ_API_KEY=your_key  # Optional, for batch mode fallback

# Database & Cache
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token

# Webhooks
WEBHOOK_BASE_URL=https://your-ngrok.ngrok-free.app

# Streaming
ENABLE_MEDIA_STREAMS=true  # Required for real-time mode
```

### Optional
```env
OPENAI_MODEL=gpt-4o-mini  # Default model
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL  # Default voice
TTS_PREFERENCE=elevenlabs
SPEECH_RECOGNITION_PREFERENCE=deepgram  # For streaming mode
ENABLE_RESPONSE_CACHING=true  # Enable AI response caching
RESPONSE_CACHE_TTL=3600  # Cache TTL in seconds
ENABLE_SPECULATIVE_TTS=true  # Enable real-time streaming pipeline (experimental)
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
1. Check `logs/combined.log` for detailed pipeline events
2. Look for `[DEBUG-STATE]`, `[DEBUG-AUDIO]`, and `[DEBUG-TRANSCRIPT]` tags
3. Monitor WebSocket connections and Deepgram events
4. Verify Redis conversation state and mappings
5. Test with `node scripts/voice-test.js +1234567890`
6. Check for persona consistency issues in responses

### Adding Voice Features
1. Update system prompt in `src/config/ai.js` (ensure NO SSML)
2. Modify intent classification in `src/services/conversation.js`
3. Update response validation logic if needed
4. Adjust turn-taking parameters in `websocketOrchestrator.js`
5. Test with voice pipeline script
6. Add unit tests for new intents

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
- **Barge-in Detection**: When user speaks during agent response, immediately stops TTS and FFmpeg
- **Speech End Detection**: 700ms silence timeout before processing final transcript
- **Duplicate Prevention**: Tracks last processed transcript and enforces 1200ms minimum between responses
- **State Management**: Multiple flags prevent race conditions:
  - `isSpeaking` - Agent currently speaking
  - `isUserSpeaking` - User currently speaking
  - `processingLLM` - LLM request in progress
  - `currentResponseId` - Tracks current response
- **Pattern Detection**: Identifies and breaks repetitive conversation loops

### WebSocket Connections
- **Twilio Media Stream**: Bidirectional audio transport (mulaw 8kHz)
- **Deepgram STT**: Real-time transcription with:
  - Voice Activity Detection (VAD) events
  - UtteranceEnd detection for robust turn-taking
  - Interim and final transcripts
  - 450ms endpointing, 1000ms utterance end
- **Turn Coordination**: Proper queueing and interruption handling

### Enhanced Conversation Features
- **Intent Classification**: Detects confusion, scam responses, denials
- **Context Injection**: Adds system messages for better responses
- **Response Validation**: Ensures AI stays in character
- **Loop Prevention**: Detects and breaks repetitive patterns
- **Smart Caching**: Skips cache for confusion/clarification requests

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
1. **Duplicate Responses**: Fixed with proper turn-taking and 1200ms debouncing
2. **Audio Interruptions**: Barge-in detection stops both TTS and FFmpeg processes
3. **Race Conditions**: State management prevents multiple concurrent LLM calls
4. **Repetitive Loops**: Pattern detection and response validation prevent stuck conversations
5. **Persona Drift**: Response validation ensures consistency with Microsoft Support character
6. **WebSocket Issues**: Ensure ENABLE_MEDIA_STREAMS=true and server restart
7. **Phone Format**: Use E.164 format (+1234567890)
8. **Webhook Connectivity**: Ensure ngrok tunnel active (see detailed setup in voice-test.js error)
9. **Context Loss**: Increased history to 30 turns, prevents premature trimming

### Debug Commands
```bash
# Test environment
node scripts/voice-test.js

# Check database
node scripts/database-test.js

# Monitor logs
tail -f logs/combined.log
```

## Recent Improvements

### Speculative TTS Streaming (NEW)
1. **Real-time streaming pipeline** - OpenAI Stream → ElevenLabs WebSocket → Twilio
2. **ElevenLabs WebSocket integration** - Direct streaming without REST API delays
3. **Minimal latency** - Audio starts playing while LLM is still generating
4. **Seamless interruption** - Barge-in properly stops all streaming processes
5. **Feature flag control** - Enable with `ENABLE_SPECULATIVE_TTS=true`

### Conversational Context Awareness
1. **Fixed dual conversation history update pattern** - Now consistently uses `appendConversation`
2. **Enhanced confusion handling** - Intelligent intent classification for various confusion types
3. **Improved system prompt** - Added loop prevention and conversation awareness instructions
4. **Increased context window** - From 15 to 30 conversation turns
5. **Smarter response caching** - Never caches confusion/repetition requests
6. **Pattern detection** - Identifies and breaks repetitive loops
7. **Response validation** - Ensures AI stays in character and doesn't drift

### Code Quality Improvements
1. **Fixed Redis exports** - Proper module.exports structure
2. **Implemented clearResponseCache** - Fully functional cache clearing
3. **Enhanced error messages** - Detailed ngrok setup instructions
4. **Optimized imports** - Moved crypto require to top level

### Voice Pipeline Race Condition Fix
1. **Fixed agent speech cutoff** - Resolved critical bug where agent's speech was interrupted after < 1 second
2. **Streaming TTS implementation** - Added `streamTextToSpeech` function in textToSpeech.js for proper streaming
3. **Refactored streamToTTS** - Updated websocketOrchestrator.js to use streaming approach preventing race conditions
4. **Decoupled caching from playback** - Audio streams immediately while caching happens asynchronously
5. **Improved error handling** - Better handling of stream errors and interruptions

## Known Issues & TODOs

1. **Testing**: Voice tests may need updates to match the new Microsoft Support persona

2. **Documentation**: Some inline comments may still reference implementation details from earlier versions

This documentation reflects the current state of the codebase with real-time streaming enabled, enhanced conversational awareness, and consistent use of the "Ben from Microsoft Support" persona throughout.