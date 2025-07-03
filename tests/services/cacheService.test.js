/* eslint-env jest */

const redis = require('../../src/config/redis');
const cacheService = require('../../src/services/cacheService');
const logger = require('../../src/utils/logger');

jest.mock('../../src/config/redis', () => require('ioredis-mock').createConnectedClient());
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
}));

describe('Cache Service', () => {
  const userId = 'test-user-123';
  const conversationKey = `conversation:${userId}`;
  const mockTurn = { role: 'user', content: 'Hello' };

  beforeEach(async () => {
    await redis.flushall();
    logger.error.mockClear();
  });

  describe('getConversation', () => {
    it('should return an empty array if no history exists', async () => {
      const history = await cacheService.getConversation(userId);
      expect(history).toEqual([]);
    });

    it('should return the parsed conversation history if it exists', async () => {
      const storedHistory = [mockTurn];
      await redis.set(conversationKey, JSON.stringify(storedHistory));
      
      const history = await cacheService.getConversation(userId);
      expect(history).toEqual(storedHistory);
    });

    it('should log an error and re-throw if Redis fails', async () => {
      redis.get = jest.fn().mockRejectedValue(new Error('Redis GET failed'));
      
      await expect(cacheService.getConversation(userId)).rejects.toThrow('Redis GET failed');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('appendConversation', () => {
    it('should create a new history if one does not exist', async () => {
      await cacheService.appendConversation(userId, mockTurn);
      
      const history = JSON.parse(await redis.get(conversationKey));
      expect(history).toEqual([mockTurn]);
      
      const ttl = await redis.ttl(conversationKey);
      expect(ttl).toBeGreaterThan(0);
    });

    it('should append to an existing history', async () => {
      const initialHistory = [{ role: 'assistant', content: 'Hi there!' }];
      await redis.set(conversationKey, JSON.stringify(initialHistory));
      
      await cacheService.appendConversation(userId, mockTurn);
      
      const history = JSON.parse(await redis.get(conversationKey));
      expect(history).toEqual([...initialHistory, mockTurn]);
    });

    it('should trim the history to the specified maxTurns', async () => {
      const longHistory = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
      await redis.set(conversationKey, JSON.stringify(longHistory));
      
      await cacheService.appendConversation(userId, mockTurn, 15);
      
      const history = JSON.parse(await redis.get(conversationKey));
      expect(history.length).toBe(15);
      expect(history[14]).toEqual(mockTurn);
    });
  });

  describe('clearConversation', () => {
    it('should delete the conversation history from Redis', async () => {
      await redis.set(conversationKey, JSON.stringify([mockTurn]));
      
      await cacheService.clearConversation(userId);
      
      const history = await redis.get(conversationKey);
      expect(history).toBeNull();
    });

    it('should not throw an error if the history does not exist', async () => {
      await expect(cacheService.clearConversation(userId)).resolves.not.toThrow();
    });
  });
}); 