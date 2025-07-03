/* eslint-env jest */

const userRepository = require('../../src/repositories/userRepository');
const supabase = require('../../src/config/supabase');
const logger = require('../../src/utils/logger');

// Mock the dependencies
jest.mock('../../src/config/supabase', () => ({
  from: jest.fn(),
  auth: {
    admin: {
      createUser: jest.fn(),
      deleteUser: jest.fn(),
    },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
}));

describe('User Repository', () => {
  const phoneNumber = '+15551234567';
  const mockUser = { id: 'user-uuid-123', email: 'test@test.com' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findUserByPhoneNumber', () => {
    it('should return a user if found', async () => {
      const mockResponse = { data: { users: mockUser }, error: null };
      supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue(mockResponse),
      });

      const user = await userRepository.findUserByPhoneNumber(phoneNumber);
      
      expect(user).toEqual(mockUser);
      expect(supabase.from).toHaveBeenCalledWith('phone_links');
    });

    it('should return null if user is not found', async () => {
      const mockResponse = { data: null, error: { code: 'PGRST116' } }; // 'No rows found'
       supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue(mockResponse),
      });

      const user = await userRepository.findUserByPhoneNumber(phoneNumber);
      
      expect(user).toBeNull();
    });

    it('should throw an error on database failure', async () => {
      const dbError = new Error('DB Error');
      const mockResponse = { data: null, error: dbError };
      supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue(mockResponse),
      });

      await expect(userRepository.findUserByPhoneNumber(phoneNumber)).rejects.toThrow('DB Error');
      expect(logger.error).toHaveBeenCalledWith('Error finding user by phone number:', dbError);
    });
  });

  describe('createGuestUserAndLinkPhone', () => {
    it('should create a guest user and link the phone number', async () => {
      const newGuestUser = { id: 'guest-uuid-456', phone: phoneNumber };
      supabase.auth.admin.createUser.mockResolvedValue({ data: { user: newGuestUser }, error: null });
      supabase.from.mockReturnValue({
        insert: jest.fn().mockResolvedValue({ error: null }),
      });

      const user = await userRepository.createGuestUserAndLinkPhone(phoneNumber);

      expect(user).toEqual(newGuestUser);
      expect(supabase.auth.admin.createUser).toHaveBeenCalledWith({
        phone: phoneNumber,
        phone_confirm: true,
        user_metadata: {
          is_guest: true,
          original_phone_number: phoneNumber,
        },
      });
      expect(supabase.from).toHaveBeenCalledWith('phone_links');
      expect(supabase.from().insert).toHaveBeenCalledWith({
        user_id: newGuestUser.id,
        phone_number: phoneNumber,
      });
    });

    it('should throw an error and not link phone if auth creation fails', async () => {
      const authError = new Error('Auth creation failed');
      supabase.auth.admin.createUser.mockResolvedValue({ data: null, error: authError });

      await expect(userRepository.createGuestUserAndLinkPhone(phoneNumber)).rejects.toThrow('Auth creation failed');
      expect(logger.error).toHaveBeenCalledWith('Error creating guest user in Supabase Auth:', authError);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('should throw and cleanup auth user if phone linking fails', async () => {
        const newGuestUser = { id: 'guest-uuid-789', phone: phoneNumber };
        const linkError = new Error('Link failed');
        supabase.auth.admin.createUser.mockResolvedValue({ data: { user: newGuestUser }, error: null });
        supabase.from.mockReturnValue({
            insert: jest.fn().mockResolvedValue({ error: linkError }),
        });
        supabase.auth.admin.deleteUser.mockResolvedValue({});

        await expect(userRepository.createGuestUserAndLinkPhone(phoneNumber)).rejects.toThrow('Link failed');
        expect(logger.error).toHaveBeenCalledWith(`Error linking phone number for guest user ${newGuestUser.id}:`, linkError);
        expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith(newGuestUser.id);
    });
  });

  describe('linkPhoneNumberToUser', () => {
      it('should successfully link a phone number to a user', async () => {
        const linkData = { user_id: mockUser.id, phone_number: phoneNumber };
        supabase.from.mockReturnValue({
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: linkData, error: null }),
        });

        const result = await userRepository.linkPhoneNumberToUser(mockUser.id, phoneNumber);

        expect(result).toEqual(linkData);
        expect(supabase.from().insert).toHaveBeenCalledWith({
            user_id: mockUser.id,
            phone_number: phoneNumber,
        });
      });
  });
}); 