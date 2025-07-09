const cacheConfig = {
  // Conversation cache settings
  conversation: {
    ttl: parseInt(process.env.CONVERSATION_TTL_HOURS, 10) * 60 * 60 || 24 * 60 * 60, // Default: 24 hours
    namespace: 'conversation',
  },

  // TTS cache settings
  tts: {
    directory: process.env.TTS_CACHE_DIR || './public/tts-cache',
    maxAge: parseInt(process.env.TTS_CACHE_MAX_AGE_DAYS, 10) * 24 * 60 * 60 * 1000 || 7 * 24 * 60 * 60 * 1000, // Default: 7 days
  },

  // Voice monitor settings
  voiceMonitor: {
    maxHistory: parseInt(process.env.VOICE_MONITOR_MAX_HISTORY, 10) || 100,
  },

  // Redis key prefixes
  keyPrefixes: {
    conversation: 'conv:',
    user: 'user:',
    call: 'call:',
    speculation: 'spec:',
    backchannel: 'bc:',
  },
};

module.exports = cacheConfig;