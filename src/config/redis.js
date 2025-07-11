const { Redis } = require('@upstash/redis');

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
    console.log('Redis connection established and warmed up');
  } catch (error) {
    console.error('Failed to warm up Redis connection:', error.message);
    isConnected = false;
  }
};

// Warm up on startup
if (process.env.NODE_ENV !== 'test') {
  warmUpConnection();
}

// Export both redis client and connection status
module.exports = redis;
module.exports.isConnected = () => isConnected;
module.exports.warmUpConnection = warmUpConnection;

module.exports = redis; 