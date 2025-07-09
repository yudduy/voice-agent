const performanceConfig = {
  // API timeout settings
  timeouts: {
    defaultApi: parseInt(process.env.DEFAULT_API_TIMEOUT_MS, 10) || 5000,
    groqSTT: parseInt(process.env.GROQ_STT_TIMEOUT_MS, 10) || 10000,
    openAI: parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 30000,
    elevenLabsTTS: parseInt(process.env.ELEVENLABS_TTS_TIMEOUT_MS, 10) || 15000,
    twilioWebhook: parseInt(process.env.TWILIO_WEBHOOK_TIMEOUT_MS, 10) || 10000,
  },

  // Retry settings
  retry: {
    maxAttempts: parseInt(process.env.DEFAULT_RETRY_COUNT, 10) || 3,
    initialDelay: parseInt(process.env.DEFAULT_RETRY_DELAY_MS, 10) || 1000,
    maxDelay: parseInt(process.env.MAX_RETRY_DELAY_MS, 10) || 5000,
    factor: parseFloat(process.env.RETRY_BACKOFF_FACTOR) || 2,
  },

  // Rate limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  },

  // Streaming settings
  streaming: {
    chunkSize: parseInt(process.env.STREAMING_CHUNK_SIZE, 10) || 1024,
    bufferSize: parseInt(process.env.STREAMING_BUFFER_SIZE, 10) || 4096,
    sentenceDetectionDelay: parseInt(process.env.SENTENCE_DETECTION_DELAY_MS, 10) || 100,
  },

  // Speculation settings
  speculation: {
    minLength: parseInt(process.env.MIN_SPECULATION_LENGTH, 10) || 15,
    correctionThreshold: parseFloat(process.env.SPECULATION_CORRECTION_THRESHOLD) || 0.25,
    maxCorrections: parseInt(process.env.MAX_SPECULATION_CORRECTIONS, 10) || 2,
  },

  // Backchannel settings
  backchannel: {
    shortDelay: parseInt(process.env.BACKCHANNEL_SHORT_DELAY_MS, 10) || 700,
    mediumDelay: parseInt(process.env.BACKCHANNEL_MEDIUM_DELAY_MS, 10) || 1500,
    longDelay: parseInt(process.env.BACKCHANNEL_LONG_DELAY_MS, 10) || 3000,
  },
};

module.exports = performanceConfig;