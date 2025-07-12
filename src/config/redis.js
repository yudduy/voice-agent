const { Redis } = require('@upstash/redis');
const logger = require('../utils/logger');

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('Upstash Redis environment variables are not set.');
}

// Configure Redis with connection optimization
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  // Connection reuse and performance optimizations
  retry: {
    retries: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 5000,
    randomize: false,
  },
  // Enable automatic command pipelining for better performance
  enableAutoPipelining: true,
  // Keep connections alive
  keepAlive: true,
});

// Implement connection warming and health check
let isConnected = false;

const warmUpConnection = async () => {
  try {
    await redis.ping();
    isConnected = true;
    logger.info('Redis connection established and warmed up');
  } catch (error) {
    logger.error('Failed to warm up Redis connection:', error);
    isConnected = false;
  }
};

// Warm up on startup
if (process.env.NODE_ENV !== 'test') {
  warmUpConnection();
}

// Export redis client and utility functions
module.exports = {
  ...redis,
  isConnected: () => isConnected,
  warmUpConnection: warmUpConnection
}; 