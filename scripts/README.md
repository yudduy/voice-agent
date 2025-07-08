# VERIES Testing Scripts

This directory contains the essential testing scripts for the VERIES voice AI system.

## Available Scripts

### 🎯 Main Voice Pipeline Test
```bash
node scripts/voice-test.js [phone_number]
```

**Purpose**: Comprehensive test of the complete voice pipeline
- **Pipeline**: Groq Whisper STT → OpenAI GPT-4o → ElevenLabs TTS
- **Target**: Real phone call to specified number (default: +19713364433)
- **Features**:
  - Tests all API connections (Twilio, ElevenLabs, Groq, OpenAI, Supabase, Redis)
  - Creates mock user with complete Supabase schema
  - Places real voice call with webhook infrastructure
  - Enhanced logging for all pipeline components
  - Validates memory retention in Redis
  - Monitors performance metrics
  - Comprehensive result validation

**Example**:
```bash
node scripts/voice-test.js +15551234567
```

### 👤 User Account Setup
```bash
node scripts/setup-user.js [phone_number] [user_name]
```

**Purpose**: Creates a complete mock user account for testing
- **Database**: Sets up all required Supabase tables
- **Schema**: auth.users, phone_links, user_profiles, preferences
- **Features**:
  - Phone number validation (E.164 format)
  - Cleanup of existing data
  - Complete database schema validation
  - Ready for voice testing

**Examples**:
```bash
# Use defaults
node scripts/setup-user.js

# Specify phone number
node scripts/setup-user.js +19713364433

# Specify phone and name
node scripts/setup-user.js +19713364433 "John Doe"
```

### 🔧 Legacy Interactive Test
```bash
node scripts/interactive-voice-test.js [phone_number]
```

**Purpose**: Legacy full pipeline test (kept for backward compatibility)
- Similar to voice-test.js but with different structure
- May be removed in future versions

## Testing Workflow

### 1. Environment Setup
Ensure all required environment variables are set:
```env
# Voice Pipeline
ELEVENLABS_API_KEY=your_key
GROQ_API_KEY=your_key
OPENAI_API_KEY=your_key

# Telephony
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_PHONE_NUMBER=+1234567890

# Database & Cache
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
UPSTASH_REDIS_REST_URL=your_url
UPSTASH_REDIS_REST_TOKEN=your_token

# Webhooks
WEBHOOK_BASE_URL=https://your-ngrok.ngrok-free.app
TEST_PHONE=+19713364433
```

### 2. Basic Test Flow
```bash
# Step 1: Set up a test user
node scripts/setup-user.js

# Step 2: Run voice pipeline test
node scripts/voice-test.js

# Step 3: Check logs for detailed results
tail -f logs/combined.log
```

## Test Coverage

### ✅ API Integrations Tested
- **Twilio**: Account validation, call placement, webhook handling
- **ElevenLabs**: TTS generation, audio caching, quality validation
- **Groq**: STT configuration, recording enablement
- **OpenAI**: GPT-4o conversation, response generation
- **Supabase**: Database operations, user management, call history
- **Redis**: Conversation state, caching, memory retention

### ✅ Voice Pipeline Components
- **Speech Recognition**: Groq Whisper v3 with recording
- **Conversation AI**: OpenAI GPT-4o with context awareness
- **Speech Synthesis**: ElevenLabs premium voices with fallbacks
- **Memory Management**: Redis-backed conversation state
- **Data Persistence**: Supabase call history and user profiles

### ✅ Real-World Scenarios
- **Live Phone Calls**: Actual Twilio voice calls to test numbers
- **Webhook Infrastructure**: Full ngrok/webhook server setup
- **Error Handling**: Fallback systems and graceful degradation
- **Performance Monitoring**: Voice pipeline metrics and logging

## Logs and Monitoring

All test logs are centralized in the `logs/` directory:
- `logs/combined.log` - All application events
- `logs/error.log` - Error events only

Enhanced logging includes:
- Pipeline stage tracking
- API response times
- Audio generation metrics
- Conversation flow validation
- Database operation results

## Troubleshooting

### Common Issues

**Environment Variables Missing**
```bash
# Validate your .env file has all required keys
node scripts/voice-test.js
# Will show detailed validation errors
```

**Webhook Connectivity**
```bash
# Make sure ngrok is running
ngrok http 3000

# Update WEBHOOK_BASE_URL in .env
WEBHOOK_BASE_URL=https://your-new-url.ngrok-free.app
```

**Database Permissions**
```bash
# Ensure you're using service role key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

**Phone Number Format**
```bash
# Use E.164 format
TEST_PHONE=+19713364433  # ✅ Correct
TEST_PHONE=9713364433    # ❌ Missing +1
```

### Debug Tips

1. **Check API Status**: Each test validates all API connections first
2. **Monitor Logs**: Use `tail -f logs/combined.log` for real-time debugging
3. **Webhook Logs**: Check ngrok dashboard for webhook request/response details
4. **Database State**: Verify user creation in Supabase dashboard
5. **Redis State**: Check conversation cache in Upstash console

## Help

For detailed help on any script:
```bash
node scripts/setup-user.js --help
node scripts/voice-test.js --help
``` 