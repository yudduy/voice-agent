// Central configuration index
// Provides a single point of access for all configuration modules

module.exports = {
  ai: require('./ai'),
  cache: require('./cache'),
  monitor: require('./monitor'),
  performance: require('./performance'),
  redis: require('./redis'),
  supabase: require('./supabase'),
  telephony: require('./telephony'),
};

// Export individual configs for backward compatibility
module.exports.aiConfig = module.exports.ai;
module.exports.cacheConfig = module.exports.cache;
module.exports.monitorConfig = module.exports.monitor;
module.exports.performanceConfig = module.exports.performance;
module.exports.redisConfig = module.exports.redis;
module.exports.supabaseConfig = module.exports.supabase;
module.exports.telephonyConfig = module.exports.telephony;