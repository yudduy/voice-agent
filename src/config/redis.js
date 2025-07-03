const Redis = require('ioredis');

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;
const redisPassword = process.env.REDIS_PASSWORD || undefined;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  maxRetriesPerRequest: null,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

module.exports = redis; 