const mongoose = require('mongoose');
const Contact = require('../models/contact');
const logger = require('../utils/logger');
const callerService = require('./caller');
const databaseService = require('./database'); // Assuming it has necessary update functions
const monitorConfig = require('../config/monitor');
const { formatPhoneForCalling } = require('../utils/phoneFormatter'); // Import formatter
const { isSafeToCall } = require('../utils/phoneSafety'); // Import safety check

let changeStream = null;
let monitorRestartTimeout = null; // Keep for restart logic
let isMonitorRunning = false; // Keep for state
let currentCallRate = 0; // Keep for rate limit
let rateLimitTimer = null; // Keep for rate limit timer
let isProcessingBatch = false; // Keep for initial scan coordination

// In-memory queue for delayed calls (WARNING: Not persistent across restarts)
const delayedCallQueue = new Map();

// Define cooldown period (e.g., 15 minutes)
const CALL_COOLDOWN_MS = 15 * 60 * 1000; 

/**
 * Resets the rate limit counter periodically.
 */
const resetRateLimit = () => {
    currentCallRate = 0;
    // Schedule the next reset
    if (rateLimitTimer) clearTimeout(rateLimitTimer); // Clear existing timer if any
    rateLimitTimer = setTimeout(resetRateLimit, monitorConfig.rateLimitIntervalMs);
};

/**
 * Processes a single contact: formats number, checks safety, initiates call.
 * Simplified - does not manage complex monitorStatus.
 */
const processContact = async (contact) => {
    logger.debug('Entering processContact', { contact });

    if (!contact || !contact.phone || !contact._id) {
        logger.warn('Attempted to process invalid contact data', { contactId: contact?._id });
        return;
    }

    const contactId = contact._id;
    const contactIdStr = contactId.toString(); 
    let lockedContact = false; // Flag to track if we successfully locked

    try {
        // --- Atomic Lock & Cooldown Check ---
        const now = new Date();
        const cooldownThreshold = new Date(now.getTime() - CALL_COOLDOWN_MS);

        const lockedDoc = await Contact.findOneAndUpdate(
            {
                _id: contactId,
                callInProgressSince: null, // Only lock if not already locked
                $or: [ // Check cooldown
                    { lastAttemptedCallAt: null },
                    { lastAttemptedCallAt: { $lte: cooldownThreshold } }
                ]
            },
            { $set: { callInProgressSince: now } }, // Lock it
            { new: true } // Return the updated (locked) doc
        ).lean();

        if (!lockedDoc) {
            // Could be locked by another process or called too recently
            // Fetch current state to log reason
            const currentState = await Contact.findById(contactId, 'callInProgressSince lastAttemptedCallAt').lean();
            logger.info(`Skipping contact: Already locked or recently called.`, { 
                contactId, 
                lockedSince: currentState?.callInProgressSince,
                lastAttempt: currentState?.lastAttemptedCallAt,
                cooldownThreshold 
            });
            return; // Stop processing
        }
        lockedContact = true; // We acquired the lock
        logger.debug('Successfully locked contact for processing', { contactId });
        // --- End Lock & Cooldown Check ---

        // Clean up from delayed queue if this execution originated from there
        if (delayedCallQueue.has(contactIdStr)) {
            clearTimeout(delayedCallQueue.get(contactIdStr).timerId);
            delayedCallQueue.delete(contactIdStr);
        }

        // Format Phone Number
        const phoneNumberToCall = formatPhoneForCalling(contact.phone);
        if (!phoneNumberToCall) {
             logger.warn('Invalid phone number format after formatting', { contactId, originalPhone: contact.phone });
             await Contact.findByIdAndUpdate(contactId, { $set: { callStatus: 'failed' }, $push: { notes: `Invalid phone format: ${contact.phone}` } });
             return; // Stop processing
        }
        logger.debug('Formatted phone number', { contactId, formattedPhone: phoneNumberToCall });
        
        // Safety Check
        const safetyResult = isSafeToCall(phoneNumberToCall);
        if (!safetyResult.isSafe) {
            logger.warn(`Phone number deemed unsafe to call: ${safetyResult.reason}`, { contactId, phone: phoneNumberToCall });
            await Contact.findByIdAndUpdate(contactId, { $set: { callStatus: 'failed' }, $push: { notes: `Blocked call (Safety: ${safetyResult.reason})` } });
            return; // Stop processing
        }
        logger.debug('Phone number passed safety check', { contactId });

        // Rate Limit Check
        if (currentCallRate >= monitorConfig.callsPerInterval) {
            logger.warn(`Rate limit reached. Skipping call for now.`, { contactId });
            // No status update here under the simplified model
            return;
        }
        currentCallRate++;

        logger.info(`Processing locked contact for calling`, { contactId, phone: contact.phone, currentRate: currentCallRate });

        // Initiate Call (This should update lastAttemptedCallAt on its own if successful)
        // We need to modify initiateCall to do this
        await callerService.initiateCall(lockedDoc); // Use the locked document data

        // If initiateCall succeeds, the lock is implicitly released by the call outcome/status updates.
        // No 'processed' status update needed here in simplified model.
        // Unlock happens automatically if initiateCall throws an error (see finally block).
        logger.info(`Successfully initiated call for locked contact`, { contactId });

    } catch (error) {
        logger.error(`Error processing locked contact`, { contactId, errorMessage: error.message, errorStack: error.stack });
        // Mark with callStatus 'failed' (if applicable)
        try {
            if (contactId && mongoose.Types.ObjectId.isValid(contactId)) {
                 await Contact.findByIdAndUpdate(contactId, { $set: { callStatus: 'failed' }, $push: { notes: `Processing/Initiation Error: ${error.message}` } });
            } 
        } catch (updateError) {
            logger.error(`Failed to mark contact callStatus as failed after processing error`, { contactId, updateErrorMessage: updateError.message });
        }
        // Rethrow or handle as needed
        // throw error; 
    } finally {
        // --- Unlock if we locked it AND an error occurred *before* successful call initiation --- 
        // If initiateCall succeeded, we don't unlock here.
        // We only unlock if we got the lock (`lockedContact = true`) but initiateCall failed.
        if (lockedContact) { 
            try {
                // Check if call was actually initiated by looking at lastAttempted vs lock time? Complex.
                // Simpler: Assume if we are in `finally` after locking, and haven't explicitly succeeded,
                // unlock it to allow retry later after cooldown. The cooldown check prevents immediate retry.
                logger.debug('Unlocking contact in finally block after processing attempt', { contactId });
                await Contact.findByIdAndUpdate(contactId, { $set: { callInProgressSince: null } });
            } catch (unlockError) {
                logger.error('CRITICAL: Failed to unlock contact in finally block!', { contactId, unlockError: unlockError.message });
                // This could lead to a permanent lock, needs monitoring/manual intervention
            }
        }
    }
};

/**
 * Handles a change event from MongoDB Change Stream.
 * Simplified: Checks only for presence of a phone number.
 */
const handleContactChange = (change) => {
    logger.debug('Received change stream event', { 
        operationType: change.operationType,
        documentKey: change.documentKey,
    });

    if (change.operationType === 'insert' || change.operationType === 'update' || change.operationType === 'replace') {
        const contactDoc = change.fullDocument || (change.operationType === 'insert' ? change.fullDocumentBeforeChange : null) || change.documentKey;
        if (!contactDoc || !contactDoc._id) {
             logger.warn('Change stream event missing document data or _id', { changeId: change._id });
            return;
        }
        const contactIdStr = contactDoc._id.toString();

        // Fetch the contact by ID to get current data
        Contact.findById(contactIdStr)
        .lean()
        .then(fetchedContact => {
            if (!fetchedContact) {
                logger.warn('Contact not found after change event, likely deleted.', { contactId: contactIdStr });
                return;
            }
            
            // Simplified Eligibility Check: Does it have a phone number?
            const hasPhone = !!fetchedContact.phone && fetchedContact.phone.trim() !== "";
            
            if (!hasPhone) {
                 logger.info('Contact is NOT eligible for processing (Missing/Empty Phone).', { 
                    contactId: contactIdStr, 
                    name: fetchedContact.name,
                    currentPhone: fetchedContact.phone 
                });
                return; // Stop processing if no phone
            }
            
            logger.info('Contact determined ELIGIBLE for processing (has phone number)', { 
                contactId: contactIdStr, 
                contactName: fetchedContact.name,
                phone: fetchedContact.phone // Log phone being considered
            });
            logger.debug('Eligible contact data:', { fetchedContact });

            // Proceed with processing (immediate or delayed based on config)
            if (monitorConfig.immediateCall) {
                logger.info(`Contact change detected, processing immediately`, { contactId: contactIdStr });
                processContact(fetchedContact); // No await needed here, process async
            } else {
                // Delayed logic remains the same, but eligibility was simpler
                if (!delayedCallQueue.has(contactIdStr)) { // Assuming delayedCallQueue is still used for delay config
                    logger.info(`Contact change detected, scheduling delayed call`, { contactId: contactIdStr, delay: monitorConfig.callDelayMs });
                    const timerId = setTimeout(() => {
                        // Re-fetch just before calling to ensure it still exists and has phone
                        Contact.findById(contactIdStr).lean().then(contactNow => {
                            if (contactNow && contactNow.phone) {
                                 logger.info(`Executing delayed call for contact`, { contactId: contactIdStr });
                                 processContact(contactNow);
                            } else {
                                 logger.warn(`Skipping delayed call for contact, missing/deleted during delay`, { contactId: contactIdStr });
                            }
                             // Ensure cleanup from map regardless of outcome inside timeout
                             if(delayedCallQueue.has(contactIdStr)) delayedCallQueue.delete(contactIdStr);
                        }).catch(fetchErr => {
                            logger.error('Error fetching contact before delayed execution', { contactId: contactIdStr, error: fetchErr.message });
                            if(delayedCallQueue.has(contactIdStr)) delayedCallQueue.delete(contactIdStr);
                        });
                    }, monitorConfig.callDelayMs);
                    delayedCallQueue.set(contactIdStr, { timerId });
                } else {
                    logger.debug(`Delayed call already scheduled for contact`, { contactId: contactIdStr });
                }
            }
        })
        .catch(err => {
            logger.error('Error fetching contact details after change event', { contactId: contactIdStr, error: err.message });
        });
    }
};

/**
 * Scans for existing contacts that need processing.
 * Updated to respect locking and cooldown.
 */
const scanExistingContacts = async () => {
    if (isProcessingBatch) {
        logger.info('Initial scan batch already in progress, skipping new scan.');
        return;
    }
    logger.info('Starting initial scan for unprocessed contacts (respecting locks/cooldown)...');
    isProcessingBatch = true; 

    try {
        let processedInBatch = 0;
        let hasMore = true;
        const now = new Date();
        const cooldownThreshold = new Date(now.getTime() - CALL_COOLDOWN_MS);

        while(hasMore) {
             const contactsToProcess = await Contact.find({
                phone: { $exists: true, $ne: "" },
                callInProgressSince: null, // Not currently locked
                $or: [ // Cooldown check
                    { lastAttemptedCallAt: null },
                    { lastAttemptedCallAt: { $lte: cooldownThreshold } }
                ]
            })
            .limit(monitorConfig.batchSize)
            .sort({ createdAt: 1 }) 
            .lean();

            if (contactsToProcess.length === 0) {
                hasMore = false;
                break;
            }

            logger.info(`Found ${contactsToProcess.length} contacts in current scan batch.`);

            for (const contact of contactsToProcess) {
                await processContact(contact);
                processedInBatch++;
                await new Promise(resolve => setTimeout(resolve, 100)); 
            }

            if (contactsToProcess.length < monitorConfig.batchSize) {
                hasMore = false;
            }
        } // end while

        logger.info(`Initial scan completed. Attempted processing for approx ${processedInBatch} contacts.`);

    } catch (error) {
        logger.error('Error during initial contact scan', { errorMessage: error.message, errorStack: error.stack });
    } finally {
        isProcessingBatch = false; 
    }
};

/**
 * Attempts to start the MongoDB Change Stream watcher. Includes retry logic.
 */
const attemptStartWatcher = (force = false) => {
    logger.info(`Start attempt check: isMonitorRunning=${isMonitorRunning}, monitorConfig.enabled=${monitorConfig.enabled}, force=${force}`);

    if ((isMonitorRunning && !force) || (!monitorConfig.enabled && !force)) {
        logger.warn(`Monitor service skipping start attempt. Running: ${isMonitorRunning}, Enabled: ${monitorConfig.enabled}, Force: ${force}`);
        return; // Skip start
    }

    if (changeStream || !monitorConfig.enabled) {
        logger.info(`Watcher already running or disabled, skipping start attempt.`);
        return; // Don't start if already running or disabled
    }
     // Clear any previous restart timeout
    if (monitorRestartTimeout) clearTimeout(monitorRestartTimeout);
    monitorRestartTimeout = null;

    logger.info('Attempting to start contact monitor service...');
    try {
        const pipeline = [
             // Only watch for operations relevant to new/updated contacts needing calls
             { $match: {
                 'operationType': { $in: ['insert', 'update', 'replace'] }
                 // Add more specific filters if needed, e.g., only watching 'phone' or 'monitorStatus' fields
             } }
        ];
        changeStream = Contact.watch(pipeline, { fullDocument: 'updateLookup' });
        isMonitorRunning = true; // Set running flag

        changeStream.on('change', handleContactChange);

        changeStream.on('error', (error) => {
            logger.error('MongoDB Change Stream error:', { errorMessage: error.message, errorStack: error.stack });
            stopWatcher(false); // Stop without clearing restart timeout
            logger.info('Scheduling watcher restart due to error...');
            if (monitorRestartTimeout) clearTimeout(monitorRestartTimeout);
            monitorRestartTimeout = setTimeout(attemptStartWatcher, 10000); // Retry after 10s (use exponential backoff in prod)
        });

        changeStream.on('close', () => {
             // Avoid restarting if stopWatcher was called intentionally
            if (changeStream) {
                 logger.warn('MongoDB Change Stream closed unexpectedly. Scheduling restart.');
                 stopWatcher(false);
                 if (monitorRestartTimeout) clearTimeout(monitorRestartTimeout);
                 monitorRestartTimeout = setTimeout(attemptStartWatcher, 5000); // Retry after 5s
            } else {
                 logger.info('MongoDB Change Stream closed normally.');
            }
        });

         changeStream.once('resumeTokenChanged', (token) => {
             logger.info('Change stream resumed/started successfully.');
             // Perform initial scan only after successfully starting/resuming
             scanExistingContacts();
             // Start the rate limit reset timer
             resetRateLimit();
         });


        logger.info('MongoDB Change Stream watcher connection initiated.');

    } catch (error) {
        logger.error('Failed to initiate Change Stream watcher', { errorMessage: error.message, errorStack: error.stack });
        stopWatcher(false); // Ensure cleanup even if initial start fails
        isMonitorRunning = false; // Ensure flag is reset on failure
        logger.info('Scheduling watcher restart due to initial start failure...');
        if (monitorRestartTimeout) clearTimeout(monitorRestartTimeout);
        monitorRestartTimeout = setTimeout(attemptStartWatcher, 15000); // Retry after 15s
    }
};


/**
 * Stops the watcher and cleans up resources.
 * @param {boolean} clearRestart - If true, cancels any pending restart timeout.
 */
const stopWatcher = (clearRestart = true) => {
    logger.info('Stopping contact monitor service...');
    if (clearRestart && monitorRestartTimeout) {
         clearTimeout(monitorRestartTimeout);
         monitorRestartTimeout = null;
         logger.debug('Cleared pending watcher restart.');
    }
    if (rateLimitTimer) {
         clearTimeout(rateLimitTimer);
         rateLimitTimer = null;
         logger.debug('Stopped rate limit timer.');
    }
    if (changeStream) {
        // Remove listeners to prevent errors during async close
        changeStream.removeAllListeners('change');
        changeStream.removeAllListeners('error');
        changeStream.removeAllListeners('close');
        changeStream.close().catch(err => logger.error('Error closing change stream', { error: err.message }));
        changeStream = null; // Nullify immediately
        logger.debug('Change stream closing process initiated.');
    }
    // Clear any pending delayed calls from memory
    delayedCallQueue.forEach(item => clearTimeout(item.timerId));
    delayedCallQueue.clear();
    isMonitorRunning = false; // Reset running flag
    logger.info(`Contact monitor service stopped. Cleared ${delayedCallQueue.size} pending delayed calls.`);
};

/**
 * Stops the current watcher (if running) and starts a new one forcefully.
 */
const resetWatcher = async () => {
    logger.info('Resetting contact monitor watcher...');
    await stopWatcher(true); // Stop and clear restart timeout
    // Ensure flag is reset before attempting start
    isMonitorRunning = false; 
    logger.info('Attempting forced restart after reset.');
    attemptStartWatcher(true); // Force start
};

/**
 * Returns the current running state of the monitor.
 * @returns {boolean}
 */
const getIsMonitorRunning = () => {
    // Check both the flag and the actual changeStream object state
    return isMonitorRunning && changeStream !== null;
};

module.exports = {
    startWatcher: attemptStartWatcher,
    stopWatcher,
    resetWatcher,
    getIsMonitorRunning,
    processContact // Export processContact if needed by direct endpoint
};
