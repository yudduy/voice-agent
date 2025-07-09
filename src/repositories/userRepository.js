const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Finds a user by their phone number.
 *
 * @param {string} phoneNumber - The E.164 formatted phone number.
 * @returns {Promise<object|null>} The user object or null if not found.
 */
async function findUserByPhoneNumber(phoneNumber) {
  const { data, error } = await supabase
    .from('phone_links')
    .select('user_id')
    .eq('phone_number', phoneNumber)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    logger.error('Error finding user by phone number:', error);
    throw error;
  }

  if (!data) return null;

  // Get user from Supabase Auth
  const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(data.user_id);
  
  if (authError) {
    logger.error('Error finding auth user:', authError);
    return null;
  }

  // Return user with consistent format
  return {
    id: authUser.user.id,
    phone: authUser.user.phone,
    name: authUser.user.user_metadata?.name || null,
    email: authUser.user.email
  };
}

/**
 * Creates a guest user in Supabase Auth and links the phone number.
 *
 * @param {string} phoneNumber - The E.164 formatted phone number.
 * @returns {Promise<object>} The newly created guest user object.
 */
async function createGuestUserAndLinkPhone(phoneNumber) {
  try {
    // 1. Create a user in Supabase Auth (simplified approach)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: `guest+${Date.now()}@veries.app`, // Use email instead of phone to avoid conflicts
      user_metadata: {
        is_guest: true,
        phone_number: phoneNumber,
        name: `Guest User`,
      },
      email_confirm: true, // Auto-confirm since it's a guest user
    });

    if (authError) {
      logger.error('Error creating guest user in Supabase Auth:', authError);
      throw authError;
    }
    
    const user = authData.user;
    logger.info('Created guest user in Auth', { userId: user.id, phoneNumber });

    // 2. Link the phone number in the phone_links table
    const { error: linkError } = await supabase
      .from('phone_links')
      .insert({
        user_id: user.id,
        phone_number: phoneNumber,
        verified: true, // Mark as verified since we're creating for voice interaction
      });

    if (linkError) {
      logger.error(`Error linking phone number for guest user ${user.id}:`, linkError);
      // Attempt to clean up the created auth user if linking fails
      await supabase.auth.admin.deleteUser(user.id);
      throw linkError;
    }

    logger.info('Successfully created and linked guest user', { userId: user.id, phoneNumber });

    // Return user with consistent format
    return {
      id: user.id,
      phone: phoneNumber, // Use the actual phone number, not from auth
      name: user.user_metadata?.name || 'Guest User',
      email: user.email
    };
  } catch (error) {
    logger.error('Failed to create guest user:', error);
    throw error;
  }
}

/**
 * Links an existing phone number to an existing user account.
 *
 * @param {string} userId - The Supabase user ID.
 * @param {string} phoneNumber - The E.164 formatted phone number.
 * @returns {Promise<object>} The created phone_links record.
 */
async function linkPhoneNumberToUser(userId, phoneNumber) {
    const { data, error } = await supabase
        .from('phone_links')
        .insert({
            user_id: userId,
            phone_number: phoneNumber,
        })
        .select()
        .single();

    if (error) {
        logger.error(`Error linking phone number to user ${userId}:`, error);
        throw error;
    }

    return data;
}

/**
 * Finds a user by their Supabase user ID.
 * This is required for production conversation flow where we already know the user ID
 * (e.g. obtained from a previous mapping stored in Redis).
 *
 * @param {object} params - Parameter object (for future-proofing).
 * @param {string} params.id - The Supabase user ID.
 * @returns {Promise<object|null>} The user record or null if not found.
 */
async function findUser({ id }) {
  if (!id) {
    logger.debug('findUser called with no ID');
    return null;
  }

  try {
    // Query the Auth table via admin API (service role key required)
    const { data, error } = await supabase.auth.admin.getUserById(id);

    if (error) {
      // Handle specific error cases
      if (error.code === 'user_not_found' || error.message.includes('User not found')) {
        logger.debug('User not found in auth.users table', { id });
        return null;
      }
      
      // Log but do not throw – conversation service will continue with a fallback name
      logger.warn('Error querying user by ID in findUser (continuing without user)', {
        id,
        error: error.message || 'Database error loading user',
        errorCode: error.code || 'unknown'
      });
      return null;
    }

    if (!data || !data.user) {
      logger.debug('No user data returned from auth.admin.getUserById', { id });
      return null;
    }

    // The user object is nested under `user` in the response
    logger.debug('Successfully found user by ID', { id, email: data.user.email });
    return data.user;
  } catch (err) {
    logger.error('Unexpected error in findUser', { id, error: err.message, stack: err.stack });
    return null;
  }
}

module.exports = {
  findUser,
  findUserByPhoneNumber,
  createGuestUser: createGuestUserAndLinkPhone,  // Alias for backwards compatibility
  createGuestUserAndLinkPhone,
  linkPhoneNumberToUser,
}; 