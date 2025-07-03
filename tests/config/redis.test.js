/* eslint-env jest */

const { Redis } = require('@upstash/redis');

describe('Upstash Redis Client Configuration', () => {
  const OLD_ENV = process.env;
  let redis;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    Redis.mockClear();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('should initialize Upstash Redis client with environment variables', () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://test-url.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    // Re-require the module inside the test to use the updated env variables
    require('../../src/config/redis');

    const Redis = global.__REDIS_CTOR__;
    expect(Redis).toHaveBeenCalledWith({
      url: 'https://test-url.upstash.io',
      token: 'test-token',
    });
  });

  it('should be a functional mock that can set and get a value', async () => {
    // Require the module here to get the instance for this test
    redis = require('../../src/config/redis');
    await redis.set('test-key', 'test-value');
    const value = await redis.get('test-key');
    expect(value).toBe('test-value');
  });
}); 