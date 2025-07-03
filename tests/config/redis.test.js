/* eslint-env jest */

const Redis = require('ioredis');

jest.mock('ioredis', () => require('ioredis-mock'));

describe('Redis Client Configuration', () => {
  const OLD_ENV = process.env;
  let redisInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    if (redisInstance) {
      redisInstance.disconnect();
    }
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('should initialize Redis client with default environment variables', () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;

    const redis = require('../../src/config/redis');
    redisInstance = redis;
    
    expect(redis.options.host).toBe('localhost');
    expect(redis.options.port).toBe(6379);
    expect(redis.options.password).toBe(undefined);
  });

  it('should initialize Redis client with custom environment variables', () => {
    process.env.REDIS_HOST = 'my-redis-host';
    process.env.REDIS_PORT = '1234';
    process.env.REDIS_PASSWORD = 'my-password';

    const redis = require('../../src/config/redis');
    redisInstance = redis;

    expect(redis.options.host).toBe('my-redis-host');
    expect(redis.options.port).toBe('1234');
    expect(redis.options.password).toBe('my-password');
  });

  it('should handle Redis connection errors', () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    const redis = require('../../src/config/redis');
    redisInstance = redis;

    redis.emit('error', new Error('Connection failed'));
    
    expect(consoleErrorSpy).toHaveBeenCalledWith('Redis connection error:', expect.any(Error));
    
    consoleErrorSpy.mockRestore();
  });
}); 