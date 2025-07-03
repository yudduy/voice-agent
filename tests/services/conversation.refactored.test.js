/* eslint-env jest */

/**
 * Conversation service tests – mocks and setup
 */

const mockOpenAICreate = jest.fn();

// ---- module mocks (must come before requires) ----
jest.mock('../../src/repositories/userRepository', () => ({
  findUser: jest.fn(),
}));

jest.mock('../../src/config/redis', () => {
  const RedisMock = require('ioredis-mock');
  return new RedisMock(); // instance with get/set/del
});

jest.mock('openai', () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: mockOpenAICreate,
            },
        },
    })),
}));

// ---- imports (after mocks) ----
const redis = require('../../src/config/redis');
const userRepository = require('../../src/repositories/userRepository');
const { OpenAI } = require('openai');

// Set dummy env vars to prevent side effects from other modules
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';

// Mock all dependencies first
jest.mock('../../src/repositories/historyRepository');
jest.mock('../../src/services/cacheService');
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/topicTracker');
jest.mock('../../src/config/redis');
jest.mock('../../src/config/ai', () => ({
  openAI: {
    apiKey: 'test-key',
    model: 'gpt-test',
    temperature: 0.5,
    maxTokens: 150,
  },
}));

const cacheService = require('../../src/services/cacheService');
const promptUtils = require('../../src/utils/prompt');
const aiConfig = require('../../src/config/ai');
const TopicTracker = require('../../src/services/topicTracker');
const conversationService = require('../../src/services/conversation');

describe('Refactored Conversation Service', () => {
    const callSid = 'CA-test-sid-123';
    const contact = { _id: 'user-test-id-456', name: 'Test User' };
    const userId = contact._id.toString();
    const callSidKey = `callsid_mapping:${callSid}`;

    beforeEach(() => {
        jest.resetAllMocks();

        // Turn redis methods into spies we can assert on
        jest.spyOn(redis, 'get').mockResolvedValue(userId);
        jest.spyOn(redis, 'set').mockResolvedValue('OK');
        jest.spyOn(redis, 'del').mockResolvedValue(1);

        // mock user repository
        userRepository.findUser.mockResolvedValue({ id: userId, name: 'Test User' });

        // ensure OpenAI chat completion returns a default response
        mockOpenAICreate.mockResolvedValue({
          choices: [{ message: { content: 'hi' } }],
        });

        // spy on prompt generator
        jest
          .spyOn(promptUtils, 'generatePersonalizedPrompt')
          .mockReturnValue(['assistant', 'How can I help?']);
    });

    describe('initializeConversation', () => {
        it('should map callSid to userId in Redis with a TTL', async () => {
            await conversationService.initializeConversation(callSid, contact);
            expect(redis.set).toHaveBeenCalledWith(callSidKey, userId, 'EX', 24 * 60 * 60);
        });

        it('should not proceed if contact or contact._id is invalid', async () => {
            await conversationService.initializeConversation(callSid, null);
            expect(redis.set).not.toHaveBeenCalled();

            await conversationService.initializeConversation(callSid, { name: 'No ID' });
            expect(redis.set).not.toHaveBeenCalled();
        });
    });

    describe('getResponse', () => {
        it('should handle a successful conversation turn', async () => {
            cacheService.getConversation.mockResolvedValue([{ role: 'user', content: 'Previous message' }]);
            promptUtils.generatePersonalizedPrompt.mockReturnValue([]);
            
            const result = await conversationService.getResponse('New message', callSid, userId);
            
            // The mock always returns 'hi' now
            expect(result).toEqual({ text: 'hi', shouldHangup: false });
            expect(cacheService.getConversation).toHaveBeenCalledWith(userId);
            expect(cacheService.appendConversation).toHaveBeenCalledTimes(2);
        });
        
        it('should return an error and hangup if callSid mapping is not found', async () => {
            redis.get.mockResolvedValue(null); // simulate missing mapping
            const result = await conversationService.getResponse('input', callSid, 'user-id-456');
            
            expect(result.text).toContain("internal error retrieving our conversation state");
        });
        
        it('should handle OpenAI API errors gracefully', async () => {
            mockOpenAICreate.mockRejectedValue(new Error('API Error'));

            const result = await conversationService.getResponse('input', callSid, userId);
            
            expect(result.text).toContain("technical difficulties");
        });

        it('should generate a prompt with the next logical topic', async () => {
          // Use real prompt builder for this test
          promptUtils.generatePersonalizedPrompt.mockRestore();

          cacheService.getConversation.mockResolvedValue([]);
          TopicTracker.getCovered.mockResolvedValue(['intro', 'product']);

          await conversationService.getResponse('a message', callSid, userId);

          expect(TopicTracker.getCovered).toHaveBeenCalledWith(userId);
        });
    });

    describe('clearConversation', () => {
        it('should clear history and mapping if found', async () => {
            redis.get.mockResolvedValue(userId);

            await conversationService.clearConversation(callSid);

            expect(redis.get).toHaveBeenCalledWith(callSidKey);
            expect(cacheService.clearConversation).toHaveBeenCalledWith(userId);
            expect(redis.del).toHaveBeenCalledWith(callSidKey);
        });

        it('should not throw if mapping is not found', async () => {
            redis.get.mockResolvedValue(null);
            
            await conversationService.clearConversation(callSid);
            
            expect(cacheService.clearConversation).not.toHaveBeenCalled();
            expect(redis.del).not.toHaveBeenCalled();
        });
    });
});

afterEach(() => {
  jest.restoreAllMocks();
}); 