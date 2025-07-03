const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Inserts a record into the call_history table.
 *
 * @param {object} callDetails - The details of the call to log.
 * @param {string} [callDetails.user_id] - The user ID, if known.
 * @param {string} callDetails.phone_number - The phone number involved in the call.
 * @param {string} callDetails.call_sid - The Twilio Call SID.
 * @param {string} [callDetails.call_status] - The final status of the call.
 * @param {number} [callDetails.duration] - The duration of the call in seconds.
 * @param {string} [callDetails.transcript] - The full transcript of the call.
 * @param {string} [callDetails.summary] - A summary of the call.
 * @returns {Promise<object>} The inserted record.
 */
async function logCall(callDetails) {
  const { data, error } = await supabase
    .from('call_history')
    .insert([callDetails])
    .select()
    .single();

  if (error) {
    logger.error('Error logging call to Supabase:', error);
    throw error;
  }

  return data;
}

/**
 * Updates an existing record in the call_history table.
 *
 * @param {string} callSid - The Twilio Call SID to identify the record.
 * @param {object} updatedDetails - The details to update.
 * @returns {Promise<object>} The updated record.
 */
async function updateCall(callSid, updatedDetails) {
  const { data, error } = await supabase
    .from('call_history')
    .update(updatedDetails)
    .eq('call_sid', callSid)
    .select()
    .single();

  if (error) {
    logger.error(`Error updating call ${callSid} in Supabase:`, error);
    throw error;
  }

  return data;
}

/**
 * Inserts a record into the sms_history table.
 *
 * @param {object} smsDetails - The details of the SMS to log.
 * @param {string} [smsDetails.user_id] - The user ID, if known.
 * @param {string} smsDetails.phone_number - The phone number involved in the SMS.
 * @param {string} smsDetails.message_sid - The Twilio Message SID.
 * @param {'inbound'|'outbound'} smsDetails.direction - The direction of the message.
 * @param {string} smsDetails.content - The body of the SMS.
 * @returns {Promise<object>} The inserted record.
 */
async function logSms(smsDetails) {
  const { data, error } = await supabase
    .from('sms_history')
    .insert([smsDetails])
    .select()
    .single();

  if (error) {
    logger.error('Error logging SMS to Supabase:', error);
    throw error;
  }

  return data;
}

module.exports = {
  logCall,
  updateCall,
  logSms,
}; 