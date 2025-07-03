/* eslint-env jest */

// Set dummy env vars to prevent side effects from other modules
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-key';

// Mock OpenAI before any other imports so that conversation service picks it up
jest.mock('openai', () => {
  const OpenAICtor = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'hi' } }],
        }),
      },
    },
  }));
  return { OpenAI: OpenAICtor };
});

// Mock dependencies before any imports
const redis = require('../../src/config/redis');
const cacheService = require('../../src/services/cacheService');
// The database service is no longer used directly by conversationService in the refactored version
// const databaseService = require('../../src/services/database');
const promptUtils = require('../../src/utils/prompt');
const aiConfig = require('../../src/config/ai');

jest.mock('../../src/config/redis');
jest.mock('../../src/services/cacheService');
// jest.mock('../../src/services/database'); // This is no longer needed
jest.mock('../../src/utils/prompt');
jest.mock('../../src/config/ai', () => ({
  openAI: {
    apiKey: 'test-key',
    model: 'gpt-test',
    temperature: 0.5,
    maxTokens: 150,
  },
}));

const { OpenAI } = require('openai');

// Import conversationService AFTER mocks are in place
const conversationService = require('../../src/services/conversation');

describe('Refactored Conversation Service', () => {
    const callSid = 'CA-test-sid-123';
    const contact = { _id: 'user-test-id-456', name: 'Test User' };
    const userId = contact._id.toString();
    const callSidKey = `callsid_mapping:${callSid}`;

    beforeEach(() => {
        jest.clearAllMocks();
        // Default mock mapping for callSid -> userId
        redis.get.mockResolvedValue(userId);
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
            redis.get.mockResolvedValue(null);
            
            const result = await conversationService.getResponse('input', callSid, 'user-id-456');
            
            expect(result.text).toContain('error');
        });
        
        it('should handle OpenAI API errors gracefully', async () => {
            jest.resetModules();
            jest.doMock('openai', () => {
              return {
                OpenAI: jest.fn().mockImplementation(() => ({
                  chat: {
                    completions: {
                      create: jest.fn().mockRejectedValue(new Error('API Error')),
                    },
                  },
                })),
              };
            });

            const conversationServiceWithFailure = require('../../src/services/conversation');
            cacheService.getConversation.mockResolvedValue([]);
            promptUtils.generatePersonalizedPrompt.mockReturnValue([]);

            redis.get.mockResolvedValue(userId);
            const result = await conversationServiceWithFailure.getResponse('input', callSid, 'user-id-456');
            
            expect(result.text).toContain('error');
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