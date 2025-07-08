/**
 * VERIES USER SETUP SCRIPT
 * =========================
 * 
 * Creates a mock user account with all required Supabase database entries
 * for testing the voice pipeline. This script sets up:
 * 
 * - auth.users entry (via integration test function)
 * - phone_links mapping
 * - user_profiles with onboarding status
 * - preferences for voice settings
 * - Initial database state for testing
 * 
 * Usage: 
 *   node scripts/setup-user.js [phone_number] [user_name]
 *   node scripts/setup-user.js +19713364433 "Test User"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { bootstrapUser } = require('../tests/utils/bootstrapUser');
const supabase = require('../src/config/supabase');
const logger = require('../src/utils/logger');

// Configuration
const DEFAULT_PHONE = '+19713364433';
const DEFAULT_NAME = 'Voice Test User';

// Parse command line arguments
const targetPhone = process.argv[2] || process.env.TEST_PHONE || DEFAULT_PHONE;
const userName = process.argv[3] || DEFAULT_NAME;

// Enhanced logging for user setup
const setupLogger = {
  info: (stage, message, data = {}) => {
    console.log(`[${stage.toUpperCase()}] ${message}`);
    if (Object.keys(data).length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
    logger.info(`User Setup - ${stage}`, { message, ...data });
  },
  
  error: (stage, message, error = {}) => {
    console.error(`[${stage.toUpperCase()}] ❌ ${message}`);
    console.error(error);
    logger.error(`User Setup - ${stage}`, { message, error: error.message || error });
  },

  success: (stage, message, data = {}) => {
    console.log(`[${stage.toUpperCase()}] ✅ ${message}`);
    if (Object.keys(data).length > 0) {
      console.log(JSON.stringify(data, null, 2));
    }
    logger.info(`User Setup Success - ${stage}`, { message, ...data });
  }
};

const validateEnvironment = () => {
  setupLogger.info('ENV_CHECK', 'Validating environment for user setup...');
  
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY'
  ];

  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    setupLogger.error('ENV_CHECK', 'Missing required environment variables', { missing });
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  setupLogger.success('ENV_CHECK', 'Environment validated for user setup');
};

const validatePhoneNumber = (phone) => {
  setupLogger.info('PHONE_VALIDATION', 'Validating phone number format...');
  
  // Basic E.164 format validation
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  
  if (!e164Regex.test(phone)) {
    setupLogger.error('PHONE_VALIDATION', 'Invalid phone number format', { 
      phone,
      expected_format: '+1234567890',
      note: 'Phone number must be in E.164 format'
    });
    throw new Error(`Invalid phone number format: ${phone}`);
  }

  setupLogger.success('PHONE_VALIDATION', 'Phone number format is valid', { phone });
};

const checkExistingUser = async (phone) => {
  setupLogger.info('EXISTING_CHECK', 'Checking for existing user with this phone number...');
  
  try {
    // Check phone_links table
    const { data: phoneLinks, error: phoneError } = await supabase
      .from('phone_links')
      .select('user_id, phone_number, verified')
      .eq('phone_number', phone);

    if (phoneError) throw phoneError;

    if (phoneLinks && phoneLinks.length > 0) {
      setupLogger.info('EXISTING_CHECK', 'Found existing user(s) with this phone number', {
        phone,
        existing_users: phoneLinks
      });
      return phoneLinks;
    }

    setupLogger.success('EXISTING_CHECK', 'No existing users found with this phone number');
    return null;
  } catch (error) {
    setupLogger.error('EXISTING_CHECK', 'Error checking for existing users', error);
    throw error;
  }
};

const cleanupExistingData = async (phone) => {
  setupLogger.info('CLEANUP', 'Cleaning up any existing data for this phone number...');
  
  try {
    // Get user IDs associated with this phone
    const { data: phoneLinks, error: phoneError } = await supabase
      .from('phone_links')
      .select('user_id')
      .eq('phone_number', phone);

    if (phoneError) throw phoneError;

    if (phoneLinks && phoneLinks.length > 0) {
      const userIds = phoneLinks.map(link => link.user_id);
      setupLogger.info('CLEANUP', 'Found user IDs to clean up', { userIds });

      // Clean up dependent tables (in order to respect foreign key constraints)
      const tables = ['call_history', 'sms_history', 'onboarding_messages', 'preferences', 'user_profiles', 'phone_links'];
      
      for (const table of tables) {
        try {
          if (table === 'phone_links') {
            // For phone_links, delete by phone_number
            const { error } = await supabase
              .from(table)
              .delete()
              .eq('phone_number', phone);
            
            if (error) throw error;
          } else {
            // For other tables, delete by user_id
            const { error } = await supabase
              .from(table)
              .delete()
              .in('user_id', userIds);
            
            if (error) throw error;
          }
          
          setupLogger.success('CLEANUP', `Cleaned up ${table} table`);
        } catch (error) {
          setupLogger.error('CLEANUP', `Failed to clean up ${table} table`, error);
          // Continue with other tables
        }
      }

      setupLogger.success('CLEANUP', 'Cleanup completed for existing data');
    } else {
      setupLogger.info('CLEANUP', 'No existing data to clean up');
    }
  } catch (error) {
    setupLogger.error('CLEANUP', 'Error during cleanup', error);
    throw error;
  }
};

const createUserAccount = async (phone, name) => {
  setupLogger.info('USER_CREATION', 'Creating new user account with complete schema...');
  
  try {
    // Generate a new UUID for the user
    const userId = require('crypto').randomUUID();
    
    setupLogger.info('USER_CREATION', 'Generated new user ID', { userId });

    // Use the bootstrapUser utility to create the complete user
    const user = await bootstrapUser({
      id: userId,
      phone: phone,
      name: name
    });

    setupLogger.success('USER_CREATION', 'User account created successfully', {
      user_id: user.id,
      phone: user.phone,
      name: user.name
    });

    return user;
  } catch (error) {
    setupLogger.error('USER_CREATION', 'Failed to create user account', error);
    throw error;
  }
};

const validateUserCreation = async (userId, phone) => {
  setupLogger.info('VALIDATION', 'Validating user creation across all tables...');
  
  try {
    const validationResults = {};

    // Check auth.users (if accessible)
    setupLogger.info('VALIDATION', 'Checking auth.users table...');
    // Note: We can't easily query auth.users with RLS, so we'll skip this validation
    
    // Check phone_links
    const { data: phoneLink, error: phoneError } = await supabase
      .from('phone_links')
      .select('*')
      .eq('phone_number', phone)
      .single();

    if (phoneError) throw new Error(`phone_links validation failed: ${phoneError.message}`);
    validationResults.phone_links = phoneLink;

    // Check user_profiles
    const { data: userProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (profileError) throw new Error(`user_profiles validation failed: ${profileError.message}`);
    validationResults.user_profiles = userProfile;

    // Check preferences
    const { data: preferences, error: prefsError } = await supabase
      .from('preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (prefsError) throw new Error(`preferences validation failed: ${prefsError.message}`);
    validationResults.preferences = preferences;

    setupLogger.success('VALIDATION', 'User creation validated successfully', {
      phone_links_verified: !!validationResults.phone_links,
      user_profiles_verified: !!validationResults.user_profiles,
      preferences_verified: !!validationResults.preferences,
      user_id: userId,
      phone_number: phone
    });

    return validationResults;
  } catch (error) {
    setupLogger.error('VALIDATION', 'User creation validation failed', error);
    throw error;
  }
};

const displayUserSummary = (user, validationResults) => {
  setupLogger.success('SUMMARY', 'User setup completed successfully');
  
  console.log('\n📋 USER ACCOUNT SUMMARY');
  console.log('='.repeat(50));
  console.log(`👤 User ID: ${user.id}`);
  console.log(`📞 Phone: ${user.phone}`);
  console.log(`📝 Name: ${user.name}`);
  console.log(`✅ Phone Link: Verified`);
  console.log(`✅ User Profile: Created`);
  console.log(`✅ Preferences: Set`);
  console.log(`🎯 Status: Ready for voice testing`);
  console.log('='.repeat(50));
  
  console.log('\n🚀 NEXT STEPS:');
  console.log('1. Run voice pipeline test:');
  console.log(`   node scripts/voice-test.js ${user.phone}`);
  console.log('2. Or use this user ID in your tests:');
  console.log(`   USER_ID="${user.id}"`);
  console.log('3. Check the logs for detailed information:');
  console.log('   tail -f logs/combined.log');
};

// Main setup function
const setupUserAccount = async () => {
  console.log('\n🎯 VERIES USER SETUP');
  console.log('='.repeat(50));
  console.log(`📞 Phone Number: ${targetPhone}`);
  console.log(`👤 User Name: ${userName}`);
  console.log(`🗄️ Database: Supabase`);
  console.log('='.repeat(50));

  try {
    // Step 1: Environment validation
    validateEnvironment();

    // Step 2: Phone number validation
    validatePhoneNumber(targetPhone);

    // Step 3: Check for existing users
    const existingUsers = await checkExistingUser(targetPhone);
    
    if (existingUsers && existingUsers.length > 0) {
      setupLogger.info('EXISTING_USER', 'Found existing user(s). Cleaning up before creating new user...');
      await cleanupExistingData(targetPhone);
    }

    // Step 4: Create new user account
    const newUser = await createUserAccount(targetPhone, userName);

    // Step 5: Validate user creation
    const validationResults = await validateUserCreation(newUser.id, targetPhone);

    // Step 6: Display summary
    displayUserSummary(newUser, validationResults);

    console.log('\n✅ User setup completed successfully!');
    
  } catch (error) {
    setupLogger.error('SETUP_FAILURE', 'User setup failed', error);
    console.error('\n💥 Setup failed:', error.message);
    console.error('\nPlease check:');
    console.error('1. Environment variables are set correctly');
    console.error('2. Supabase service role key has proper permissions');
    console.error('3. Database schema is up to date');
    process.exit(1);
  }
};

// Display help if requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
🎯 VERIES USER SETUP SCRIPT

Usage:
  node scripts/setup-user.js [phone_number] [user_name]

Examples:
  node scripts/setup-user.js
  node scripts/setup-user.js +19713364433
  node scripts/setup-user.js +19713364433 "John Doe"

Environment Variables Required:
  SUPABASE_URL              - Your Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY - Service role key for admin access
  TEST_PHONE                - Default phone number (optional)

The script will create a complete user account with:
  ✅ auth.users entry
  ✅ phone_links mapping  
  ✅ user_profiles with onboarding status
  ✅ preferences for voice settings
  ✅ Ready for voice pipeline testing
`);
  process.exit(0);
}

// Run the setup
if (require.main === module) {
  setupUserAccount().catch(console.error);
}

module.exports = { setupUserAccount }; 