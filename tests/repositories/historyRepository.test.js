/* eslint-env jest */

const historyRepository = require('../../src/repositories/historyRepository');
const supabase = require('../../src/config/supabase');
const logger = require('../../src/utils/logger');

// Mock dependencies
jest.mock('../../src/config/supabase', () => ({
  from: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
}));

describe('History Repository', () => {
  let mockSupabaseFrom;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock setup
    mockSupabaseFrom = {
      insert: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn(),
    };
    supabase.from.mockReturnValue(mockSupabaseFrom);
  });

  describe('logCall', () => {
    const callDetails = {
      user_id: 'user-uuid-123',
      phone_number: '+15551234567',
      call_sid: 'CA1234567890',
      duration: 60,
      transcript: 'Hello world',
    };

    it('should insert a call record into the call_history table', async () => {
      mockSupabaseFrom.single.mockResolvedValue({ data: callDetails, error: null });

      const result = await historyRepository.logCall(callDetails);

      expect(supabase.from).toHaveBeenCalledWith('call_history');
      expect(mockSupabaseFrom.insert).toHaveBeenCalledWith([callDetails]);
      expect(result).toEqual(callDetails);
    });

    it('should throw an error if the database insert fails', async () => {
      const dbError = new Error('Insert failed');
      mockSupabaseFrom.single.mockResolvedValue({ data: null, error: dbError });

      await expect(historyRepository.logCall(callDetails)).rejects.toThrow('Insert failed');
      expect(logger.error).toHaveBeenCalledWith('Error logging call to Supabase:', dbError);
    });
  });

  describe('logSms', () => {
    const smsDetails = {
      user_id: 'user-uuid-456',
      phone_number: '+15557654321',
      message_sid: 'SM1234567890',
      direction: 'inbound',
      content: 'Hi there',
    };

    it('should insert an SMS record into the sms_history table', async () => {
      mockSupabaseFrom.single.mockResolvedValue({ data: smsDetails, error: null });

      const result = await historyRepository.logSms(smsDetails);

      expect(supabase.from).toHaveBeenCalledWith('sms_history');
      expect(mockSupabaseFrom.insert).toHaveBeenCalledWith([smsDetails]);
      expect(result).toEqual(smsDetails);
    });

    it('should throw an error if the database insert fails', async () => {
      const dbError = new Error('Insert failed');
      mockSupabaseFrom.single.mockResolvedValue({ data: null, error: dbError });

      await expect(historyRepository.logSms(smsDetails)).rejects.toThrow('Insert failed');
      expect(logger.error).toHaveBeenCalledWith('Error logging SMS to Supabase:', dbError);
    });
  });
}); 