# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VERIES Caller** is a sophisticated voice AI calling agent that places outbound phone calls and has natural conversations using a production-ready voice pipeline:

**Pipeline**: Groq distil-whisper STT → OpenAI GPT-4.1-nano → ElevenLabs Flash v2.5

**🎯 Current Status**: Production-ready with sequential processing. Advanced streaming components are fully implemented but currently disabled to prevent audio cutoff issues.

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

### Voice Pipeline (Current Production)
1. **Incoming Call** → Twilio → `/api/calls/connect` (greeting)
2. **User Speech** → Twilio STT → `/api/calls/respond` 
3. **AI Processing** → OpenAI GPT-4.1-nano → Redis context
4. **Speech Synthesis** → ElevenLabs TTS → Audio playback
5. **Loop** → Gather for next input

### Data Flow
- **Supabase**: User profiles, call history, preferences
- **Redis**: Real-time conversation state, call mappings
- **Local Cache**: TTS audio files (`/public/tts-cache/`)

### Active Components
- **Webhooks**: `unifiedTwilioWebhooks.js` (single active handler)
- **Services**: `conversation.js`, `speechToText.js`, `textToSpeech.js`
- **Repositories**: `userRepository.js`, `historyRepository.js`

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
- `src/webhooks/unifiedTwilioWebhooks.js` - **ACTIVE** webhook handler
- `src/webhooks/audioWebhooks.js` - Audio file serving
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

## Advanced Features (Available but Disabled)

### Streaming Components (Fully Implemented)
- `services/streamingConversation.js` - OpenAI streaming
- `services/speculativeEngine.js` - Predictive processing
- `services/backchannelManager.js` - Natural conversation flow
- `services/ttsQueue.js` - Prioritized TTS generation

### Why Currently Disabled
The streaming pipeline was causing audio cutoff issues where responses would be interrupted mid-sentence. The system is configured to use sequential processing for reliability.

### To Re-enable (when issues resolved)
```env
ENABLE_STREAMING=true
ENABLE_SPECULATIVE_EXECUTION=true
ENABLE_BACKCHANNELS=true
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
1. **Audio Cutoff**: Check for SSML in AI responses
2. **TwiML Validation**: Ensure clean XML generation
3. **Environment Variables**: Verify all required keys set
4. **Phone Format**: Use E.164 format (+1234567890)
5. **Webhook Connectivity**: Ensure ngrok tunnel active

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