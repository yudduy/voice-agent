/* eslint-env jest */

// Mock dependencies before any imports
const redis = require('../../src/config/redis');
const cacheService = require('../../src/services/cacheService');
const databaseService = require('../../src/services/database');
const promptUtils = require('../../src/utils/prompt');
const aiConfig = require('../../src/config/ai');
const conversationService = require('../../src/services/conversation');

jest.mock('../../src/config/redis');
jest.mock('../../src/services/cacheService');
jest.mock('../../src/services/database');
jest.mock('../../src/utils/prompt');
jest.mock('../../src/config/ai', () => ({
  openAI: {
    apiKey: 'test-key',
    model: 'gpt-test',
    temperature: 0.5,
    maxTokens: 150,
  },
}));
// Mock the OpenAI client itself, which is initialized inside conversation.js
jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: jest.fn(),
            },
        },
    }));
});
const { OpenAI } = require('openai');
const openaiInstance = new OpenAI();


describe('Refactored Conversation Service', () => {
    const callSid = 'CA-test-sid-123';
    const contact = { _id: 'user-test-id-456', name: 'Test User' };
    const userId = contact._id.toString();
    const callSidKey = `callsid_mapping:${callSid}`;

    beforeEach(() => {
        jest.clearAllMocks();
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
            redis.get.mockResolvedValue(userId);
            cacheService.getConversation.mockResolvedValue([{ role: 'user', content: 'Previous message' }]);
            promptUtils.generatePersonalizedPrompt.mockReturnValue([]);
            openaiInstance.chat.completions.create.mockResolvedValue({
                choices: [{ message: { content: 'AI Response' } }],
            });

            const result = await conversationService.getResponse('New message', callSid);

            expect(redis.get).toHaveBeenCalledWith(callSidKey);
            expect(cacheService.getConversation).toHaveBeenCalledWith(userId);
            expect(promptUtils.generatePersonalizedPrompt).toHaveBeenCalled();
            expect(cacheService.appendConversation).toHaveBeenCalledTimes(2);
            expect(result.text).toBe('AI Response');
            expect(result.shouldHangup).toBe(false);
        });
        
        it('should return an error and hangup if callSid mapping is not found', async () => {
            redis.get.mockResolvedValue(null);
            
            const result = await conversationService.getResponse('input', callSid);
            
            expect(result.text).toContain('internal error');
            expect(result.shouldHangup).toBe(true);
        });
        
        it('should handle OpenAI API errors gracefully', async () => {
            redis.get.mockResolvedValue(userId);
            cacheService.getConversation.mockResolvedValue([]);
            promptUtils.generatePersonalizedPrompt.mockReturnValue([]);
            openaiInstance.chat.completions.create.mockRejectedValue(new Error('API Error'));

            const result = await conversationService.getResponse('input', callSid);

            expect(result.text).toContain('technical difficulties');
            expect(result.shouldHangup).toBe(true);
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