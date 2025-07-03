/* eslint-env jest */

const cacheService = require('../../src/services/cacheService');
const logger = require('../../src/utils/logger');
const redis = require('../../src/config/redis'); // This is now our global ioredis-mock instance

jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
}));

describe('Cache Service', () => {
  const userId = 'test-user-123';
  const conversationKey = `conversation:${userId}`;
  const mockTurn = { role: 'user', content: 'Hello' };

  beforeEach(() => {
    logger.error.mockClear();
    // Ensure fresh state for each test
    if (typeof redis.flushall === 'function') redis.flushall();
  });

  describe('getConversation', () => {
    it('should return a parsed conversation history if it exists', async () => {
      // Use the mock redis instance directly
      await redis.set(conversationKey, JSON.stringify([mockTurn]));
      const result = await cacheService.getConversation(userId);
      expect(result).toEqual([mockTurn]);
    });

    it('should return an empty array if the history does not exist', async () => {
      const result = await cacheService.getConversation(userId);
      expect(result).toEqual([]);
    });

    it('should log an error and re-throw if Redis fails', async () => {
      // Spy on the globally-mocked redis instance
      jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Redis GET failed'));
      
      await expect(cacheService.getConversation(userId)).rejects.toThrow('Redis GET failed');
      expect(logger.error).toHaveBeenCalledWith(`Error getting conversation for user ${userId} from Redis:`, expect.any(Error));
    });
  });

  describe('appendConversation', () => {
    it('should create a new history and set a TTL', async () => {
      await cacheService.appendConversation(userId, mockTurn);
      const history = JSON.parse(await redis.get(conversationKey));
      expect(history).toEqual([mockTurn]);
      const ttl = await redis.ttl(conversationKey);
      expect(ttl).toBeGreaterThan(0);
    });

    it('should log an error and re-throw if set fails', async () => {
      // The implementation uses get/set, not lpush
      jest.spyOn(redis, 'set').mockRejectedValueOnce(new Error('Redis SET failed'));

      await expect(cacheService.appendConversation(userId, mockTurn)).rejects.toThrow('Redis SET failed');
      expect(logger.error).toHaveBeenCalledWith(`Error appending conversation for user ${userId} to Redis:`, expect.any(Error));
    });
  });

  describe('clearConversation', () => {
    it('should delete the conversation history', async () => {
      await redis.set(conversationKey, 'data');
      await cacheService.clearConversation(userId);
      const result = await redis.get(conversationKey);
      expect(result).toBeNull();
    });

    it('should log an error and re-throw if del fails', async () => {
      jest.spyOn(redis, 'del').mockRejectedValueOnce(new Error('Redis DEL failed'));

      await expect(cacheService.clearConversation(userId)).rejects.toThrow('Redis DEL failed');
      expect(logger.error).toHaveBeenCalledWith(`Error clearing conversation for user ${userId} from Redis:`, expect.any(Error));
    });
  });
}); 