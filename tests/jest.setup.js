/* eslint-env jest */

// Mock Upstash Redis with ioredis-mock (constructor spy defined inside factory)
jest.mock('@upstash/redis', () => {
  const RedisMock = require('ioredis-mock');

  // Spy-able constructor
  const RedisCtor = jest.fn((opts) => {
    const client = new RedisMock();
    client.options = opts;
    client.disconnect = client.quit.bind(client);
    return client;
  });

  // Expose for test assertions
  global.__REDIS_CTOR__ = RedisCtor;

  return { Redis: RedisCtor };
});

// Clear Redis data and reset constructor between tests
afterEach(() => {
  const RedisCtor = global.__REDIS_CTOR__;
  if (RedisCtor) {
    RedisCtor.mockClear();

    const lastCall = RedisCtor.mock.results[RedisCtor.mock.results.length - 1];
    const client = lastCall?.value;
    if (client && typeof client.flushall === 'function') {
      client.flushall();
    }
  }
});

// This setup file is run before each test file.
// We are globally mocking libraries to prevent any real network connections during any test. 