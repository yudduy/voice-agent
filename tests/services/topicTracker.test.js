/* eslint-env jest */

const TopicTracker = require('../../src/services/topicTracker');
const redis = require('../../src/config/redis');

// As this is a new test file, we must ensure the global mocks are active.
jest.mock('../../src/config/redis', () => new (require('ioredis-mock'))());

describe('Topic Tracker Service', () => {
  const userId = 'test-user-topics';

  beforeEach(() => {
    // Ensure Redis is clean before each test
    redis.flushall();
  });

  it('should return an empty array for a user with no tracked topics', async () => {
    const topics = await TopicTracker.getCovered(userId);
    expect(topics).toEqual([]);
  });

  it('should correctly mark a single topic as covered', async () => {
    await TopicTracker.markCovered(userId, 'pricing');
    const topics = await TopicTracker.getCovered(userId);
    expect(topics).toEqual(['pricing']);
  });

  it('should handle marking multiple topics, avoiding duplicates', async () => {
    await TopicTracker.markCovered(userId, 'pricing');
    await TopicTracker.markCovered(userId, 'features');
    await TopicTracker.markCovered(userId, 'pricing'); // Mark duplicate

    const topics = await TopicTracker.getCovered(userId);
    // Using a Set for comparison to ignore order
    expect(new Set(topics)).toEqual(new Set(['pricing', 'features']));
  });

  it('should persist topics between different calls', async () => {
    await TopicTracker.markCovered(userId, 'intro');
    let topics = await TopicTracker.getCovered(userId);
    expect(topics).toEqual(['intro']);

    await TopicTracker.markCovered(userId, 'product');
    topics = await TopicTracker.getCovered(userId);
    expect(new Set(topics)).toEqual(new Set(['intro', 'product']));
  });
}); 