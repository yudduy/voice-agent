/**
 * AI model configuration for VERIES
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4.1-nano', // Latest nano model for optimal speed
  streamingModel: process.env.OPENAI_STREAMING_MODEL || 'gpt-4.1-nano', 
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-nano',
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'), // Increased for more personality
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '150', 10), // Normal conversational length
  streamingMaxTokens: parseInt(process.env.AI_STREAMING_MAX_TOKENS || '200', 10), 
  systemPrompt: `You are a professional AI assistant designed to provide helpful, informative, and courteous support. Your role is to assist callers with their inquiries in a professional and respectful manner.

  CORE PRINCIPLES:
  - Provide helpful and accurate information to the best of your ability
  - Maintain a professional, friendly, and respectful tone
  - Keep responses concise and conversational (1-2 sentences per turn)
  - Listen actively and respond appropriately to user needs
  - Be transparent about your capabilities and limitations

  CONVERSATION GUIDELINES:
  - Greet callers professionally and ask how you can assist them
  - Listen carefully to understand their specific needs or questions
  - Provide clear, helpful responses based on their requests
  - If you cannot help with something, politely explain your limitations
  - Offer alternative solutions or suggest appropriate resources when possible
  - Maintain conversation flow naturally and professionally

  RESPONSE STYLE:
  - Use clear, professional language
  - Be concise but informative
  - Show empathy and understanding
  - Avoid technical jargon unless specifically requested
  - Adapt your communication style to match the caller's needs

  EXAMPLE INTERACTIONS:
  - Initial greeting: "Hello, thank you for calling. How may I assist you today?"
  - Clarifying needs: "I understand you're looking for help with that. Let me see how I can best assist you."
  - Providing information: "Based on what you've shared, I can help you with that."
  - Handling limitations: "I'm not able to assist with that specific request, but I can suggest some alternatives."
  - Professional closure: "Is there anything else I can help you with today?"`
};

const hyperbolic = {
  apiKey: process.env.HYPERBOLIC_API_KEY,
  ttsEndpoint: 'https://api.hyperbolic.xyz/v1/audio/generation',
  defaultOptions: {
    // Customize default TTS options such as voice, speed, etc. here if needed
  },
  enabled: !!process.env.HYPERBOLIC_API_KEY, // Enable this only if the API key is provided
};

const elevenLabs = {
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Default to Bella voice
  ttsEndpoint: 'https://api.elevenlabs.io/v1/text-to-speech',
  streamTtsEndpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream',
  defaultOptions: {
    voice_settings: {
      stability: 0.75,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true
    },
    model_id: 'eleven_flash_v2_5', // Fastest and most cost-effective model
    output_format: 'mp3_44100_128', // Ensure consistent high-quality output
    optimize_streaming_latency: 0 // Disable streaming optimization for complete audio
  },
  enabled: !!process.env.ELEVENLABS_API_KEY, // Enable this only if the API key is provided
};

const speechPreferences = {
  sttPreference: process.env.SPEECH_RECOGNITION_PREFERENCE || 'deepgram', // Default to deepgram for media streams
  enableRecording: process.env.ENABLE_RECORDING === 'true', // Convert string to boolean
  enableGroqStt: process.env.ENABLE_GROQ_TRANSCRIPTION === 'true',
  ttsPreference: process.env.TTS_PREFERENCE || 'elevenlabs', // Use ElevenLabs exclusively
};

const groqConfig = {
    apiKey: process.env.GROQ_API_KEY,
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'distil-whisper',
    enabled: speechPreferences.enableGroqStt && !!process.env.GROQ_API_KEY,
};

const deepgramConfig = {
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: 'nova-3', // Latest model for best performance
  language: 'en',
  smart_format: true,
  diarize: false, // Disable for speed unless needed
  punctuate: true,
  enabled: !!process.env.DEEPGRAM_API_KEY,
};





module.exports = {
  openAI,
  hyperbolic,
  elevenLabs,
  speechPreferences,
  groqConfig,
  deepgramConfig,
};
