/**
 * AI model configuration for VERIES
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4.1-nano', // Using the cheapest model
  streamingModel: process.env.OPENAI_STREAMING_MODEL || 'gpt-4.1-nano', // Using the cheapest model
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-nano', // Keep analysis model consistent or separate if needed
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.3'),
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '60', 10),
  streamingMaxTokens: parseInt(process.env.AI_STREAMING_MAX_TOKENS || '120', 10), // Lower for faster streaming
  // SYSTEM PROMPT: This prompt should instruct the AI to generate concise, on-topic responses,
  // knowing that the generated text will later be converted to audio via ElevenLabs.
  systemPrompt: `You are a professional voice AI assistant. You are calling someone to assist them.

  CRITICAL RULES:
  - Respond ONLY with plain text - NO XML, HTML, or SSML tags
  - NO special markup like <break>, <prosody>, [pause], etc.
  - Keep responses extremely brief: MAXIMUM 2 sentences per turn
  - Wait for user response after each turn
  - Be direct and ask for permission/approval before proceeding
  - Sound natural and conversational, not robotic
  - Your text will be converted to audio via TTS
  
  Example good response: "Hi, this is an AI assistant calling to help you. Is now a good time to chat?"
  Example bad response: "Hello! <break time='1s'/> I can help you with that and provide detailed information about various topics."`
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
  sttPreference: process.env.SPEECH_RECOGNITION_PREFERENCE || 'groq', // Default to groq
  enableRecording: process.env.ENABLE_RECORDING === 'true', // Convert string to boolean
  enableGroqStt: process.env.ENABLE_GROQ_TRANSCRIPTION === 'true',
  ttsPreference: process.env.TTS_PREFERENCE || 'elevenlabs', // Use ElevenLabs exclusively
  enableStreaming: process.env.ENABLE_STREAMING === 'true',
};

const groqConfig = {
    apiKey: process.env.GROQ_API_KEY,
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'distil-whisper',
    enabled: speechPreferences.enableGroqStt && !!process.env.GROQ_API_KEY,
};





module.exports = {
  openAI,
  hyperbolic,
  elevenLabs,
  speechPreferences,
  groqConfig,
};
