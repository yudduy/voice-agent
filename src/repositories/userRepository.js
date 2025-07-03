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
    .select('user_id, users(*)')
    .eq('phone_number', phoneNumber)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    logger.error('Error finding user by phone number:', error);
    throw error;
  }

  if (!data) {
    return null;
  }

  // The user data is nested; we extract it.
  return data.users;
}

/**
 * Creates a guest user in Supabase Auth and links the phone number.
 *
 * @param {string} phoneNumber - The E.164 formatted phone number.
 * @returns {Promise<object>} The newly created guest user object.
 */
async function createGuestUserAndLinkPhone(phoneNumber) {
  // 1. Create a user in Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    phone: phoneNumber,
    phone_confirm: true, // Mark phone as confirmed since we're interacting via it
    user_metadata: {
      is_guest: true,
      original_phone_number: phoneNumber,
    },
  });

  if (authError) {
    logger.error('Error creating guest user in Supabase Auth:', authError);
    throw authError;
  }
  const user = authData.user;
  // 2. Link the phone number in the phone_links table
  const { error: linkError } = await supabase
    .from('phone_links')
    .insert({
      user_id: user.id,
      phone_number: phoneNumber,
    });

  if (linkError) {
    logger.error(`Error linking phone number for guest user ${user.id}:`, linkError);
    // Attempt to clean up the created auth user if linking fails
    await supabase.auth.admin.deleteUser(user.id);
    throw linkError;
  }

  return user;
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

module.exports = {
  findUserByPhoneNumber,
  createGuestUserAndLinkPhone,
  linkPhoneNumberToUser,
}; 