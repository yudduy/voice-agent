/**
 * AI model configuration for VERIES
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4.1-nano',
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini', // Keep analysis model consistent or separate if needed
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.3'),
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '200', 10),
  // SYSTEM PROMPT: This prompt should instruct the AI to generate concise, on-topic responses,
  // knowing that the generated text will later be converted to audio via ElevenLabs.
  systemPrompt: `You are a highly specialized voice AI assistant for VERIES. Your sole function is to assist the request of the user to your best ability verbally. All your textual responses will be converted to audio using our dedicated ElevenLabs TTS service. Remain strictly on topic, provide concise responses (1-3 sentences), and do not address unrelated queries.`
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
    model_id: 'eleven_flash_v2_5' // Ultra-low latency model for conversational use cases
  },
  enabled: !!process.env.ELEVENLABS_API_KEY, // Enable this only if the API key is provided
};

const speechPreferences = {
  sttPreference: process.env.SPEECH_RECOGNITION_PREFERENCE || 'groq', // Default to groq
  enableRecording: process.env.ENABLE_RECORDING === 'true', // Convert string to boolean
  enableGroqStt: process.env.ENABLE_GROQ_TRANSCRIPTION === 'true',
  ttsPreference: process.env.TTS_PREFERENCE || 'elevenlabs', // Default to ElevenLabs
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
