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
  featureFlags: require('./featureFlags')
};