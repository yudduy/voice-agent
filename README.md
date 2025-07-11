# Caller AI 📞

A voice-first AI agent designed for outbound calling campaigns with dynamic persona support.

* **Dynamic Personas**: Easily configurable personas for different campaigns (currently: "Ben" from Microsoft Support).
* **Smart Call Logic**: Handles various call scenarios, user responses, and natural conversation flow.
* **Voice Pipeline**: **Groq Whisper STT → OpenAI GPT-4o-mini → ElevenLabs TTS**
* **Storage**: Long-term memory in **Supabase Postgres**, short-term context in **Upstash Redis**
* **Monitoring**: Comprehensive call/transcript logging with detailed state tracking
* **Barge-in Protection**: Advanced interruption handling with grace periods to prevent false triggers

---

## Voice Pipeline Architecture

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Speech-to-Text** | Groq Whisper v3 (primary) + Twilio STT (fallback) | High-accuracy transcription with recording |
| **Conversation AI** | OpenAI GPT-4o-mini (150 tokens) | Dynamic and context-aware persona handling |
| **Text-to-Speech** | ElevenLabs Flash v2.5 (primary) + Hyperbolic (fallback) + Twilio (final) | Premium voice synthesis optimized for speed |
| **Telephony** | Twilio Voice API | Reliable call handling and audio streaming |
| **Database** | Supabase Postgres | User profiles, call history, and conversation logs |
| **Cache** | Upstash Redis | Real-time call state and conversation context |

## Current Persona: "Ben" from Microsoft Support

The AI is currently configured as "Ben," a technical support specialist who:
- Claims to be calling from Microsoft Support
- Reports a detected virus on the user's computer
- Uses urgent, professional language with Indian accent patterns
- Follows a multi-step conversational approach to build trust
- Maintains short, natural responses (1-2 sentences max)

### Conversation Flow Strategy
1. **Initial Contact**: Professional introduction with virus warning
2. **Verification**: Asks user to confirm computer details
3. **Escalation**: Builds urgency about the threat
4. **Solution Offer**: Proposes technical support service
5. **Payment Request**: Requests payment for "firewall protection"

---

## Key Features

### Advanced Barge-in Handling
- **Grace Period**: 400ms buffer prevents false interruption detection
- **Cooldown System**: 600ms cooldown after barge-in to prevent loops
- **FFmpeg Management**: Proper cleanup of audio processes during interruptions
- **State Tracking**: Detailed logging of all speech events and transitions

### Conversation Management
- **Intent Classification**: Recognizes confusion, repetition requests, and scam responses
- **Context Awareness**: Maintains conversation history and user state
- **Natural Flow**: Avoids robotic responses with conversational patterns
- **Error Recovery**: Handles various user responses and edge cases

### Performance Optimizations
- **Streaming TTS**: Real-time audio generation and delivery
- **Speculative Processing**: Parallel AI response generation
- **Connection Pooling**: Efficient resource management
- **Audio Caching**: Reduces latency for repeated phrases

---

## Quick Start

### Prerequisites
- Node.js 18+
- Twilio Account (Voice API)
- OpenAI API Key
- ElevenLabs API Key
- Groq API Key
- Supabase Project
- Upstash Redis Instance

### Installation
```bash
# Clone and install dependencies
git clone <repository-url>
cd caller
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your API keys and credentials

# Set up database
npm run db:migrate

# Start the server
npm start
```

### Testing
```bash
# Test the voice pipeline
node scripts/voice-test.js

# Test streaming functionality
node scripts/test-streaming.js

# Test database connectivity
node scripts/database-test.js
```

---

## Configuration

### Environment Variables
```env
# Core Services
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key
GROQ_API_KEY=your_groq_key

# Database
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key

# Cache
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# AI Configuration
AI_MAX_TOKENS=150
AI_STREAMING_MAX_TOKENS=200
AI_TEMPERATURE=0.7
```

### Persona Customization
The AI persona is defined in `src/config/ai.js`. To modify the character:

1. Update the `systemPrompt` with new character details
2. Adjust conversation flow logic in `src/services/conversation.js`
3. Modify initial greetings in webhook handlers
4. Update SMS templates in `src/services/smsHandler.js`

---

## Architecture

### Core Components
- **WebSocket Orchestrator**: Manages real-time voice communication
- **Conversation Service**: Handles AI response generation and context
- **TTS Service**: Manages text-to-speech synthesis and streaming
- **STT Service**: Handles speech recognition and transcription
- **Database Repositories**: User and conversation data management
- **Cache Service**: Real-time state and context management

### Call Flow
1. **Incoming Call**: Twilio webhook initiates connection
2. **User Lookup**: Database query for caller information
3. **Greeting**: AI introduces itself with persona
4. **Conversation Loop**: STT → AI Processing → TTS → Audio Delivery
5. **Barge-in Handling**: Interrupt detection and graceful recovery
6. **Call Completion**: Cleanup and logging

---

## Monitoring & Debugging

### Logging
- **Structured Logging**: JSON format with correlation IDs
- **State Transitions**: Detailed call state tracking
- **Performance Metrics**: Audio delivery and processing times
- **Error Tracking**: Comprehensive error logging with context

### Available Scripts
- `scripts/voice-test.js`: Test voice pipeline components
- `scripts/test-streaming.js`: Test streaming functionality
- `scripts/database-test.js`: Verify database connectivity
- `scripts/setup-user.js`: Create test users

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
