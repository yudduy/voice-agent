/**
 * Feature flags for voice pipeline optimizations
 * Each flag can be independently enabled/disabled via environment variables
 */

const featureFlags = {
  // WebSocket connection pooling
  ENABLE_WEBSOCKET_POOLING: process.env.FF_WEBSOCKET_POOLING === 'true' || false,
  WEBSOCKET_POOL_SIZE: parseInt(process.env.FF_WEBSOCKET_POOL_SIZE) || 3,
  
  // FFmpeg process pooling
  ENABLE_FFMPEG_POOLING: process.env.FF_FFMPEG_POOLING === 'true' || false,
  FFMPEG_POOL_SIZE: parseInt(process.env.FF_FFMPEG_POOL_SIZE) || 5,
  
  // Enhanced caching
  ENABLE_AUDIO_RESPONSE_CACHE: process.env.FF_AUDIO_RESPONSE_CACHE === 'true' || false,
  ENABLE_PHONETIC_MATCHING: process.env.FF_PHONETIC_MATCHING === 'true' || false,
  ENABLE_SPECULATIVE_CACHE: process.env.FF_SPECULATIVE_CACHE === 'true' || false,
  AUDIO_CACHE_TTL: parseInt(process.env.FF_AUDIO_CACHE_TTL) || 3600,
  
  // Deepgram optimizations
  ENABLE_OPTIMIZED_VAD: process.env.FF_OPTIMIZED_VAD === 'true' || false,
  VAD_ENDPOINTING_MS: parseInt(process.env.FF_VAD_ENDPOINTING_MS) || 450,
  VAD_UTTERANCE_END_MS: parseInt(process.env.FF_VAD_UTTERANCE_END_MS) || 1000,
  
  // Streaming optimizations
  ENABLE_STREAMING_OPTIMIZATION: process.env.FF_STREAMING_OPTIMIZATION === 'true' || false,
  OPTIMIZED_CHUNK_SIZE: parseInt(process.env.FF_CHUNK_SIZE) || 1024,
  ENABLE_SENTENCE_BOUNDARY: process.env.FF_SENTENCE_BOUNDARY === 'true' || false,
  
  // Advanced optimizations
  ENABLE_SPECULATIVE_PROCESSING: process.env.FF_SPECULATIVE_PROCESSING === 'true' || false,
  ENABLE_AUDIO_PREPROCESSING: process.env.FF_AUDIO_PREPROCESSING === 'true' || false,
  
  // Performance thresholds
  MAX_ACCEPTABLE_LATENCY: parseInt(process.env.FF_MAX_LATENCY_MS) || 1000,
  ENABLE_CIRCUIT_BREAKER: process.env.FF_CIRCUIT_BREAKER === 'true' || true,
  CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env.FF_CIRCUIT_BREAKER_THRESHOLD) || 5,
  
  // Logging and monitoring
  ENABLE_PERFORMANCE_LOGGING: process.env.FF_PERFORMANCE_LOGGING === 'true' || true,
  LOG_LATENCY_DETAILS: process.env.FF_LOG_LATENCY_DETAILS === 'true' || true
};

// Validate feature flag combinations
const validateFeatureFlags = () => {
  const warnings = [];
  
  if (featureFlags.ENABLE_SPECULATIVE_PROCESSING && !featureFlags.ENABLE_OPTIMIZED_VAD) {
    warnings.push('Speculative processing requires optimized VAD to be effective');
  }
  
  if (featureFlags.ENABLE_AUDIO_PREPROCESSING && !featureFlags.ENABLE_AUDIO_RESPONSE_CACHE) {
    warnings.push('Audio preprocessing requires audio response cache to be enabled');
  }
  
  if (featureFlags.VAD_ENDPOINTING_MS < 200) {
    warnings.push('VAD endpointing below 200ms may cause premature cutoffs');
  }
  
  return warnings;
};

// Log feature flag status on startup
const logFeatureFlags = (logger) => {
  logger.info('Voice Pipeline Feature Flags:', {
    websocketPooling: featureFlags.ENABLE_WEBSOCKET_POOLING,
    ffmpegPooling: featureFlags.ENABLE_FFMPEG_POOLING,
    audioCache: featureFlags.ENABLE_AUDIO_RESPONSE_CACHE,
    optimizedVAD: featureFlags.ENABLE_OPTIMIZED_VAD,
    streamingOptimization: featureFlags.ENABLE_STREAMING_OPTIMIZATION,
    speculativeProcessing: featureFlags.ENABLE_SPECULATIVE_PROCESSING
  });
  
  const warnings = validateFeatureFlags();
  if (warnings.length > 0) {
    logger.warn('Feature flag warnings:', warnings);
  }
};

module.exports = {
  featureFlags,
  validateFeatureFlags,
  logFeatureFlags
};