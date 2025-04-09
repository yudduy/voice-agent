/**
 * AI model configuration for Foundess Caller
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4',  // Use OpenAI 4.0 for text responses
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4', // Keep analysis model consistent or separate if needed
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.3'),
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '200', 10),
  // SYSTEM PROMPT: This prompt should instruct the AI to generate concise, on-topic responses,
  // knowing that the generated text will later be converted to audio via Hyperbolic.
  systemPrompt: `You are a highly specialized voice AI assistant for Foundess. Your sole function is to conduct investor preference interviews with founders using the OpenAI GPT-4 model to generate your text-based responses. All your textual responses will be converted to audio using our dedicated Hyperbolic TTS service. Remain strictly on topic, provide concise responses (1-3 sentences), and do not address unrelated queries.`
};

const hyperbolic = {
  apiKey: process.env.HYPERBOLIC_API_KEY,
  ttsEndpoint: 'https://api.hyperbolic.xyz/v1/audio/generation',
  defaultOptions: {
    // Customize default TTS options such as voice, speed, etc. here if needed
  },
  enabled: !!process.env.HYPERBOLIC_API_KEY, // Enable this only if the API key is provided
};

const speechPreferences = {
  sttPreference: process.env.SPEECH_RECOGNITION_PREFERENCE || 'groq', // Default to groq
  enableRecording: process.env.ENABLE_RECORDING === 'true', // Convert string to boolean
  enableGroqStt: process.env.ENABLE_GROQ_TRANSCRIPTION === 'true',
};

const groqConfig = {
    apiKey: process.env.GROQ_API_KEY,
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3',
    enabled: speechPreferences.enableGroqStt && !!process.env.GROQ_API_KEY,
};

module.exports = {
  openAI,
  hyperbolic,
  speechPreferences,
  groqConfig,
};
