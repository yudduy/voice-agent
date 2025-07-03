/* eslint-env jest */

// Mock dependencies
const userRepository = require('../../src/repositories/userRepository');
const historyRepository = require('../../src/repositories/historyRepository');
const cacheService = require('../../src/services/cacheService');
const aiConfig = require('../../src/config/ai');
const twilio = require('twilio');
const smsHandler = require('../../src/services/smsHandler');
const logger = require('../../src/utils/logger');

jest.mock('../../src/repositories/userRepository');
jest.mock('../../src/repositories/historyRepository');
jest.mock('../../src/services/cacheService');
jest.mock('../../src/utils/logger');
jest.mock('../../src/config/ai', () => ({
  openai: {
    chat: {
      completions: {
        create: jest.fn(),
      },
    },
  },
}));

// Mock Twilio client
const twilioCreateMock = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({
    messages: {
        create: twilioCreateMock,
    }
})));


describe('SMS Handler Service', () => {
    const twilioPayload = { From: '+15550001111', Body: 'Hello AI', MessageSid: 'SM_SID_IN' };
    const mockUser = { id: 'user-123' };
    const aiResponse = 'This is the AI response.';
    const twilioResponse = { sid: 'SM_SID_OUT' };

    beforeEach(() => {
        jest.clearAllMocks();

        // Setup default successful mock implementations
        userRepository.findUserByPhoneNumber.mockResolvedValue(mockUser);
        userRepository.createGuestUserAndLinkPhone.mockResolvedValue({ id: 'guest-456' });
        historyRepository.logSms.mockResolvedValue({});
        cacheService.getConversation.mockResolvedValue([]);
        cacheService.appendConversation.mockResolvedValue();
        aiConfig.openai.chat.completions.create.mockResolvedValue({
            choices: [{ message: { content: aiResponse } }],
        });
        twilioCreateMock.mockResolvedValue(twilioResponse);
    });

    it('should process an incoming SMS for an existing user correctly', async () => {
        await smsHandler.handleIncomingSms(twilioPayload);

        // 1. User lookup
        expect(userRepository.findUserByPhoneNumber).toHaveBeenCalledWith(twilioPayload.From);
        expect(userRepository.createGuestUserAndLinkPhone).not.toHaveBeenCalled();

        // 2. Logging (inbound)
        expect(historyRepository.logSms).toHaveBeenCalledWith(expect.objectContaining({
            message_sid: twilioPayload.MessageSid,
            direction: 'inbound',
            content: twilioPayload.Body,
        }));

        // 3. AI completion
        expect(aiConfig.openai.chat.completions.create).toHaveBeenCalled();
        
        // 4. Twilio response
        expect(twilioCreateMock).toHaveBeenCalledWith({
            body: aiResponse,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: twilioPayload.From,
        });

        // 5. Logging (outbound)
        expect(historyRepository.logSms).toHaveBeenCalledWith(expect.objectContaining({
            message_sid: twilioResponse.sid,
            direction: 'outbound',
            content: aiResponse,
        }));

        // 6. Cache update
        expect(cacheService.appendConversation).toHaveBeenCalledTimes(2);
    });

    it('should create a new guest user if no user is found', async () => {
        userRepository.findUserByPhoneNumber.mockResolvedValue(null);

        await smsHandler.handleIncomingSms(twilioPayload);
        
        expect(userRepository.createGuestUserAndLinkPhone).toHaveBeenCalledWith(twilioPayload.From);
        expect(historyRepository.logSms).toHaveBeenCalledWith(expect.objectContaining({
            user_id: 'guest-456' // Ensure guest ID is used for logging
        }));
    });

    it('should send a fallback message if OpenAI fails', async () => {
        aiConfig.openai.chat.completions.create.mockRejectedValue(new Error('AI go boom'));

        await smsHandler.handleIncomingSms(twilioPayload);
        
        expect(twilioCreateMock).toHaveBeenCalledWith(expect.objectContaining({
            body: "Sorry, I'm having a little trouble right now. Please try again in a moment.",
        }));
        expect(logger.error).toHaveBeenCalledWith('Error getting completion from OpenAI:', expect.any(Error));
    });
}); 