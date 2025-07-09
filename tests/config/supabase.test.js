/* eslint-env jest */

// Task-A Fix: Reset modules and mock dependencies *before* the module under test is required.
jest.resetModules();

const mockCreateClient = jest.fn();
jest.doMock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));

// Set dummy env vars required by the module
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

// Now, require the module that we are testing. It will pick up the mock above.
require('../../src/config/supabase');
const { createClient } = require('@supabase/supabase-js');


describe('Supabase Client Configuration', () => {
  it('should initialize Supabase client exactly once with correct credentials', () => {
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-anon-key'
    );
  });

  // The tests for missing env vars need their own isolated setup.
  describe('when environment variables are missing', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...OLD_ENV };
    });

    afterAll(() => {
      process.env = OLD_ENV;
    });

    it('should throw an error if SUPABASE_URL is not defined', () => {
      delete process.env.SUPABASE_URL;
      process.env.SUPABASE_ANON_KEY = 'test-anon-key';

      expect(() => {
        require('../../src/config/supabase');
      }).toThrow('Supabase URL and a valid key are required.');
    });

    it('should throw an error if SUPABASE_ANON_KEY is not defined', () => {
      process.env.SUPABASE_URL = 'https://test.supabase.co';
      delete process.env.SUPABASE_ANON_KEY;

      expect(() => {
        require('../../src/config/supabase');
      }).toThrow('Supabase URL and a valid key are required.');
    });
  });
}); 