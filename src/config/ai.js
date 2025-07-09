/**
 * AI model configuration for VERIES
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini', // Changed from gpt-4.1-nano for better performance
  streamingModel: process.env.OPENAI_STREAMING_MODEL || 'gpt-4o-mini', // Optimized model for streaming
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini', // Keep analysis model consistent or separate if needed
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.3'),
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '200', 10),
  streamingMaxTokens: parseInt(process.env.AI_STREAMING_MAX_TOKENS || '120', 10), // Lower for faster streaming
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
  enableStreaming: process.env.ENABLE_STREAMING === 'true',
  enableSpeculativeExecution: process.env.ENABLE_SPECULATIVE_EXECUTION === 'true',
  enableBackchannels: process.env.ENABLE_BACKCHANNELS === 'true',
  enableWebRTC: process.env.ENABLE_WEBRTC === 'true',
};

const groqConfig = {
    apiKey: process.env.GROQ_API_KEY,
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'distil-whisper',
    enabled: speechPreferences.enableGroqStt && !!process.env.GROQ_API_KEY,
};

const speculativeConfig = {
    enabled: speechPreferences.enableSpeculativeExecution,
    minSpeculationLength: parseInt(process.env.SPECULATION_MIN_LENGTH || '12', 10),
    maxSpeculationLength: parseInt(process.env.SPECULATION_MAX_LENGTH || '50', 10),
    correctionThreshold: parseFloat(process.env.SPECULATION_CORRECTION_THRESHOLD || '0.25'),
    confidenceThreshold: parseFloat(process.env.SPECULATION_CONFIDENCE_THRESHOLD || '0.65'),
    speculationTimeout: parseInt(process.env.SPECULATION_TIMEOUT || '2000', 10),
    pivotTimeout: parseInt(process.env.SPECULATION_PIVOT_TIMEOUT || '100', 10),
};

const backchannelConfig = {
    enabled: speechPreferences.enableBackchannels,
    minDelayForBackchannel: parseInt(process.env.BACKCHANNEL_MIN_DELAY || '250', 10),
    maxBackchannelDuration: parseInt(process.env.BACKCHANNEL_MAX_DURATION || '2000', 10),
    emergencyThreshold: parseInt(process.env.BACKCHANNEL_EMERGENCY_THRESHOLD || '1200', 10),
    conflictAvoidanceMargin: parseInt(process.env.BACKCHANNEL_CONFLICT_MARGIN || '100', 10),
    
    // Backchannel type preferences
    acknowledgmentWeight: parseFloat(process.env.BACKCHANNEL_ACKNOWLEDGMENT_WEIGHT || '0.3'),
    processingWeight: parseFloat(process.env.BACKCHANNEL_PROCESSING_WEIGHT || '0.4'),
    thinkingWeight: parseFloat(process.env.BACKCHANNEL_THINKING_WEIGHT || '0.2'),
    empathyWeight: parseFloat(process.env.BACKCHANNEL_EMPATHY_WEIGHT || '0.1'),
};

const webrtcConfig = {
    enabled: speechPreferences.enableWebRTC,
    provider: process.env.WEBRTC_PROVIDER || 'daily', // daily, livekit
    sampleRate: parseInt(process.env.WEBRTC_SAMPLE_RATE || '16000', 10),
    chunkSize: parseInt(process.env.WEBRTC_CHUNK_SIZE || '1024', 10),
    vadThreshold: parseFloat(process.env.WEBRTC_VAD_THRESHOLD || '0.5'),
    silenceTimeout: parseInt(process.env.WEBRTC_SILENCE_TIMEOUT || '500', 10),
    
    // Daily.co configuration
    dailyApiKey: process.env.DAILY_API_KEY,
    dailyRoomUrl: process.env.DAILY_ROOM_URL,
    
    // LiveKit configuration
    livekitServerUrl: process.env.LIVEKIT_SERVER_URL,
    livekitApiKey: process.env.LIVEKIT_API_KEY,
    livekitApiSecret: process.env.LIVEKIT_API_SECRET,
};

const advancedOptimizations = {
    // Predictive processing
    enablePredictiveProcessing: process.env.ENABLE_PREDICTIVE_PROCESSING === 'true',
    predictiveBufferSize: parseInt(process.env.PREDICTIVE_BUFFER_SIZE || '5', 10),
    
    // Smart buffering
    enableSmartBuffering: process.env.ENABLE_SMART_BUFFERING === 'true',
    bufferPrerollMs: parseInt(process.env.BUFFER_PREROLL_MS || '200', 10),
    bufferPostrollMs: parseInt(process.env.BUFFER_POSTROLL_MS || '100', 10),
    
    // Edge optimization
    enableEdgeOptimization: process.env.ENABLE_EDGE_OPTIMIZATION === 'true',
    cdnCaching: process.env.ENABLE_CDN_CACHING === 'true',
    
    // Performance monitoring
    enableDetailedMetrics: process.env.ENABLE_DETAILED_METRICS === 'true',
    metricsInterval: parseInt(process.env.METRICS_INTERVAL || '1000', 10),
    
    // Emergency handling
    enableEmergencyFallbacks: process.env.ENABLE_EMERGENCY_FALLBACKS === 'true',
    maxProcessingTime: parseInt(process.env.MAX_PROCESSING_TIME || '3000', 10),
    emergencyResponseText: process.env.EMERGENCY_RESPONSE_TEXT || 'I apologize, but I\'m experiencing technical difficulties. Please try again.',
};

module.exports = {
  openAI,
  hyperbolic,
  elevenLabs,
  speechPreferences,
  groqConfig,
  speculativeConfig,
  backchannelConfig,
  webrtcConfig,
  advancedOptimizations,
};
