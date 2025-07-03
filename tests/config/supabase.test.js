/* eslint-env jest */

const { createClient } = require('@supabase/supabase-js');

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

describe('Supabase Client Configuration', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    createClient.mockClear();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('should initialize Supabase client with environment variables', () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    require('../../src/config/supabase');

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      'https://test.supabase.co',
      'test-anon-key'
    );
  });

  it('should throw an error if SUPABASE_URL is not defined', () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';

    expect(() => {
      require('../../src/config/supabase');
    }).toThrow('Supabase URL and Anon Key are required.');
  });

  it('should throw an error if SUPABASE_ANON_KEY is not defined', () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    delete process.env.SUPABASE_ANON_KEY;

    expect(() => {
      require('../../src/config/supabase');
    }).toThrow('Supabase URL and Anon Key are required.');
  });
}); 