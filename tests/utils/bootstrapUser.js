const supabase = require('../../src/config/supabase');
const logger = require('../../src/utils/logger');

/**
 * Ensure a user exists in all relevant tables for voice-call tests.
 * 1. auth.users (minimal record via SQL function)
 * 2. phone_links
 * 3. preferences (basic row)
 * 4. call_history (optional seed record)
 *
 * @param {Object} params
 * @param {string} params.id        – UUID to use for user
 * @param {string} params.phone     – E.164 formatted phone number (+1…)
 * @param {string} [params.name]    – Display name (default "Test User")
 * @returns {Promise<object>}       – The user object
 */
async function bootstrapUser({ id, phone, name = 'Test User' }) {
  if (!id || !phone) throw new Error('bootstrapUser requires id and phone');

  const requestedUserId = id;
  const phoneNumber = phone.startsWith('+') ? phone.slice(1) : phone;
  const testEmail = `test-${id.slice(0, 8)}@integration.test`;
  
  logger.info('Starting user bootstrap', { userId: requestedUserId, phone });

  let actualUserId = requestedUserId;

  // 1. Create minimal auth.users record using SQL function
  try {
    const { data: authResult, error: authError } = await supabase.rpc('create_integration_test_user', {
      p_id: requestedUserId,
      p_phone: phoneNumber,
      p_email: testEmail
    });

    if (authError) throw authError;
    
    if (authResult?.error) {
      logger.warn('Auth user creation had issues', { userId: requestedUserId, result: authResult });
      // Don't throw - continue with bootstrap
    } else {
      // Use the actual user ID returned by the function (could be existing user)
      actualUserId = authResult?.id || requestedUserId;
      logger.info('Auth user ensured', { 
        requestedId: requestedUserId, 
        actualId: actualUserId, 
        status: authResult?.status 
      });
    }
  } catch (err) {
    logger.error('Failed to create auth user', { userId: requestedUserId, error: err.message });
    throw err;
  }

  // 2. Ensure phone_links row (unique on phone_number)
  try {
    const { data: existingLink, error: linkLookupErr } = await supabase
      .from('phone_links')
      .select('id, user_id')
      .eq('phone_number', phone)
      .maybeSingle();

    if (linkLookupErr) throw linkLookupErr;

    if (!existingLink) {
      // Insert new link
      const { error: linkInsertErr } = await supabase
        .from('phone_links')
        .insert({ user_id: actualUserId, phone_number: phone, verified: true });
      if (linkInsertErr && linkInsertErr.code !== '23505') throw linkInsertErr;
      logger.info('Created phone_links record', { userId: actualUserId, phone });
    } else if (existingLink.user_id !== actualUserId) {
      // Update link to point to correct user
      await supabase
        .from('phone_links')
        .update({ user_id: actualUserId, verified: true })
        .eq('id', existingLink.id)
        .throwOnError();
      logger.info('Updated phone_links record', { userId: actualUserId, phone });
    } else {
      logger.info('Phone_links record already exists', { userId: actualUserId, phone });
    }
  } catch (err) {
    logger.error('Failed to ensure phone_links', { id: actualUserId, phone, error: err.message });
    throw err;
  }

  // 3. Ensure preferences row
  try {
    const { error: prefErr } = await supabase
      .from('preferences')
      .upsert({ user_id: actualUserId }, { onConflict: 'user_id' });
    if (prefErr) throw prefErr;
    logger.info('Ensured preferences record', { userId: actualUserId });
  } catch (err) {
    logger.error('Failed to ensure preferences', { id: actualUserId, error: err.message });
    throw err;
  }

  // 4. Ensure a call_history seed record exists (helps with foreign key constraints)
  try {
    const { data: existingHistory } = await supabase
      .from('call_history')
      .select('id')
      .eq('user_id', actualUserId)
      .limit(1)
      .maybeSingle();

    if (!existingHistory) {
      // Create a placeholder call_history record using correct schema
      const { error: historyErr } = await supabase
        .from('call_history')
        .insert({
          user_id: actualUserId,
          call_sid: 'test-bootstrap-' + Date.now(),
          phone_number: phone,
          call_status: 'bootstrap',
          duration: 0,
          transcript: 'Bootstrap placeholder record'
        });
      
      if (historyErr && historyErr.code !== '23505') {
        // Log but don't throw - this is optional
        logger.warn('Could not create call_history seed', { 
          id: actualUserId, 
          error: historyErr.message,
          code: historyErr.code 
        });
      } else {
        logger.info('Created call_history seed record', { userId: actualUserId });
      }
    }
  } catch (err) {
    logger.warn('Could not create call_history seed', { id: actualUserId, error: err.message });
    // Don't throw - this is optional
  }

  const user = {
    id: actualUserId,
    phone: phoneNumber,
    email: testEmail,
    name: name,
    created_at: new Date().toISOString()
  };

  logger.info('🆗  User bootstrap complete', { id: actualUserId, phone });
  return user;
}

module.exports = { bootstrapUser }; 