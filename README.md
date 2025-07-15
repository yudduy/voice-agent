# Voice AI Assistant 🎤

A professional voice-first AI assistant system designed for intelligent outbound calling campaigns with dynamic conversation management.

## Features

* **Advanced Voice Pipeline**: Real-time speech processing with Deepgram STT → OpenAI GPT → ElevenLabs TTS
* **Intelligent Conversation Management**: Context-aware dialogue with natural conversation flow
* **Robust Architecture**: Enterprise-grade scalability with Supabase PostgreSQL and Redis caching
* **Real-time Processing**: WebSocket-based media streaming with advanced barge-in handling
* **Comprehensive Monitoring**: Detailed call logging, performance metrics, and state tracking
* **Professional Voice Synthesis**: High-quality text-to-speech with multiple provider fallbacks

---

## Architecture Overview

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Speech Recognition** | Deepgram Nova-3 (primary) + Groq Whisper (fallback) | Real-time speech-to-text with high accuracy |
| **AI Processing** | OpenAI GPT-4 Turbo | Intelligent conversation management |
| **Voice Synthesis** | ElevenLabs Flash v2.5 (primary) + Twilio (fallback) | Natural text-to-speech generation |
| **Telephony** | Twilio Voice API | Reliable call handling and audio streaming |
| **Database** | Supabase PostgreSQL | User profiles, call history, conversation logs |
| **Cache** | Redis | Real-time conversation state and performance optimization |

---

## Technical Capabilities

### Advanced Call Management
- **Intelligent Barge-in Handling**: Sophisticated interruption detection with grace periods
- **Context-Aware Responses**: Maintains conversation history and user preferences
- **Dynamic Flow Control**: Adaptive conversation routing based on user input
- **Error Recovery**: Robust handling of various call scenarios and edge cases

### Performance Optimizations
- **Streaming Audio Processing**: Real-time audio generation and delivery
- **Connection Pooling**: Efficient resource management for high-volume operations
- **Intelligent Caching**: Reduces latency through strategic audio and response caching
- **Parallel Processing**: Concurrent AI response generation for optimal performance

### Enterprise Features
- **Comprehensive Logging**: Structured logging with correlation IDs and performance metrics
- **Scalable Architecture**: Designed for high-volume concurrent operations
- **Security Best Practices**: Secure credential management and data protection
- **Monitoring & Analytics**: Real-time performance tracking and call analytics

---

## Quick Start

### Prerequisites
- Node.js 18+
- Twilio Account with Voice API access
- OpenAI API access
- ElevenLabs API access
- Supabase project
- Redis instance (Upstash recommended)

### Installation
```bash
# Clone repository
git clone https://github.com/your-username/voice-ai-assistant
cd voice-ai-assistant

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API credentials

# Initialize database
npm run db:migrate

# Start the application
npm start
```

### Testing
```bash
# Test voice pipeline
node scripts/voice-test.js

# Test streaming functionality
node scripts/test-streaming.js

# Verify database connectivity
node scripts/database-test.js
```

---

## Configuration

### Environment Variables
```env
# Core Services
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=your_twilio_number
OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key
DEEPGRAM_API_KEY=your_deepgram_key

# Database & Cache
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_key
UPSTASH_REDIS_REST_URL=your_redis_url
UPSTASH_REDIS_REST_TOKEN=your_redis_token

# Application Settings
WEBHOOK_BASE_URL=your_webhook_url
ENABLE_MEDIA_STREAMS=true
```

### AI Configuration
The AI assistant behavior is configured in `src/config/ai.js`. Key settings include:
- Response length and temperature
- Conversation flow parameters
- Voice synthesis preferences
- Context management settings

---

## System Architecture

### Core Components
- **WebSocket Orchestrator**: Manages real-time voice communication
- **Conversation Service**: Handles AI response generation and context management
- **Speech Services**: Manages STT/TTS processing and streaming
- **Database Layer**: User data and conversation persistence
- **Cache Layer**: Real-time state management and performance optimization

### Call Flow
1. **Call Initiation**: Twilio webhook establishes connection
2. **User Recognition**: Database lookup for caller information
3. **Conversation Management**: Real-time STT → AI Processing → TTS pipeline
4. **Audio Streaming**: Bidirectional audio with intelligent interruption handling
5. **Session Management**: Context preservation and cleanup

---

## Development

### Available Scripts
- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload
- `npm test` - Run comprehensive test suite
- `npm run lint` - Code quality checks
- `npm run db:migrate` - Database migrations

### Testing Tools
- `scripts/voice-test.js` - End-to-end voice pipeline testing
- `scripts/test-streaming.js` - Stream processing validation
- `scripts/database-test.js` - Database connectivity verification
- `scripts/setup-user.js` - Test user creation

### Performance Monitoring
- Structured logging with performance metrics
- Real-time call state tracking
- Audio processing latency monitoring
- Error tracking and alerting

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For technical support and documentation, please refer to the project wiki or create an issue in the GitHub repository.