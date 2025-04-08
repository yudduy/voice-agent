const mongoose = require('mongoose');
const Contact = require('../models/contact');
const logger = require('../utils/logger');
const callerService = require('./caller');
const databaseService = require('./database'); // Assuming it has necessary update functions
const monitorConfig = require('../config/monitor');

let changeStream = null;
let isProcessingBatch = false; // Simple flag for initial scan batching
let monitorRestartTimeout = null; // Timeout handle for restart logic
let isMonitorRunning = false; // Explicit state flag

// In-memory queue for delayed calls (WARNING: Not persistent across restarts)
const delayedCallQueue = new Map();
let currentCallRate = 0;
let rateLimitTimer = null;

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
 * Processes a single contact: initiates call and updates status.
 */
const processContact = async (contact) => {
    if (!contact || !contact.phone || !contact._id) {
        logger.warn('Attempted to process invalid contact data', { contactId: contact?._id });
        return;
    }

    const contactId = contact._id;
    const contactIdStr = contactId.toString(); // Use string for map keys

    // Clean up from delayed queue if this execution originated from there
    if (delayedCallQueue.has(contactIdStr)) {
        clearTimeout(delayedCallQueue.get(contactIdStr).timerId);
        delayedCallQueue.delete(contactIdStr);
    }

    try {
        // Atomically mark as processing to prevent race conditions
        const originalDoc = await Contact.findOneAndUpdate(
            { _id: contactId, monitorStatus: { $in: ['pending', 'error', null] } },
            { $set: { monitorStatus: 'processing' } },
            { new: false } // Return the original document
        ).lean(); // Use lean as we only check if it was found

        if (!originalDoc) {
            logger.info(`Contact already being processed or status changed, skipping`, { contactId });
            return;
        }

        // Rate Limit Check
        if (currentCallRate >= monitorConfig.callsPerInterval) {
            logger.warn(`Rate limit reached (${monitorConfig.callsPerInterval}/${monitorConfig.rateLimitIntervalMs}ms). Reverting contact status to pending.`, { contactId });
            await Contact.findByIdAndUpdate(contactId, { $set: { monitorStatus: 'pending' } });
            // Consider adding to a persistent retry queue or increasing delay
            return;
        }
        currentCallRate++;

        logger.info(`Processing contact for calling`, { contactId, phone: contact.phone, currentRate: currentCallRate });

        // Initiate Call
        // Use the original document's data if available, otherwise the potentially minimal input 'contact' object
        const contactDataForCall = originalDoc || contact;
        await callerService.initiateCall(contactDataForCall);

        // Mark as processed successfully
        await Contact.findByIdAndUpdate(contactId, {
            $set: { monitorStatus: 'processed', monitorProcessedAt: new Date() }
        });
        logger.info(`Successfully initiated call and marked contact as processed`, { contactId });

    } catch (error) {
        logger.error(`Error processing contact`, { contactId, errorMessage: error.message, errorStack: error.stack });
        // Mark as error for potential retry
        try {
            await Contact.findByIdAndUpdate(contactId, { $set: { monitorStatus: 'error' } });
        } catch (updateError) {
            logger.error(`Failed to mark contact as error after processing failure`, { contactId, updateErrorMessage: updateError.message });
        }
    }
};

/**
 * Handles a change event from MongoDB Change Stream.
 */
const handleContactChange = (change) => {
    logger.debug('Received change stream event', { operationType: change.operationType });

    // Interested in inserts and updates/replaces that might add/change a phone or status
    if (change.operationType === 'insert' || change.operationType === 'update' || change.operationType === 'replace') {
        // Use fullDocument if available (for updates/replaces), otherwise the document key (for inserts)
        const contactDoc = change.fullDocument || (change.operationType === 'insert' ? change.fullDocumentBeforeChange : null) || change.documentKey;

        if (!contactDoc || !contactDoc._id) {
            logger.warn('Change stream event missing document data or _id', { changeId: change._id });
            return;
        }

        const contactIdStr = contactDoc._id.toString();

        // Fetch the latest full state to ensure eligibility check is accurate
        Contact.findOne({
            _id: contactDoc._id,
            phone: { $exists: true, $ne: "" },
            monitorStatus: { $in: ['pending', 'error', null] } // Check if it needs processing
        })
        .lean()
        .then(eligibleContact => {
            if (!eligibleContact) {
                logger.debug('Contact from change stream event is not eligible for processing', { contactId: contactIdStr });
                return;
            }

            if (monitorConfig.immediateCall) {
                logger.info(`Contact change detected, processing immediately`, { contactId: contactIdStr });
                processContact(eligibleContact); // No await needed here, process async
            } else {
                if (!delayedCallQueue.has(contactIdStr)) {
                    logger.info(`Contact change detected, scheduling delayed call`, { contactId: contactIdStr, delay: monitorConfig.callDelayMs });
                    const timerId = setTimeout(() => {
                        // Fetch again right before calling in case status changed during delay
                        Contact.findById(contactIdStr).lean().then(contactNow => {
                            if (contactNow && contactNow.monitorStatus !== 'processed') {
                                 logger.info(`Executing delayed call for contact`, { contactId: contactIdStr });
                                 processContact(contactNow);
                            } else {
                                 logger.info(`Skipping delayed call for contact, status changed during delay`, { contactId: contactIdStr });
                            }
                            delayedCallQueue.delete(contactIdStr); // Clean up after execution attempt
                        }).catch(fetchErr => {
                            logger.error('Error fetching contact before delayed execution', { contactId: contactIdStr, error: fetchErr.message });
                            delayedCallQueue.delete(contactIdStr); // Clean up on error
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
 */
const scanExistingContacts = async () => {
    if (isProcessingBatch) {
        logger.info('Initial scan batch already in progress, skipping new scan.');
        return;
    }
    logger.info('Starting initial scan for unprocessed contacts...');
    isProcessingBatch = true; // Set flag immediately

    try {
        let processedInBatch = 0;
        let hasMore = true;

        while(hasMore) {
             const contactsToProcess = await Contact.find({
                phone: { $exists: true, $ne: "" },
                monitorStatus: { $in: ['pending', 'error', null] }
            })
            .limit(monitorConfig.batchSize)
            .sort({ createdAt: 1 }) // Process older ones first
            .lean();

            if (contactsToProcess.length === 0) {
                hasMore = false;
                break;
            }

            logger.info(`Found ${contactsToProcess.length} contacts in current batch.`);

            for (const contact of contactsToProcess) {
                // Await processing to respect rate limits more effectively during scan
                await processContact(contact);
                processedInBatch++;
                // Optional small delay between calls in batch to spread load
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // If we fetched less than the batch size, we're done
            if (contactsToProcess.length < monitorConfig.batchSize) {
                hasMore = false;
            }
        } // end while

        logger.info(`Initial scan completed. Processed approx ${processedInBatch} contacts.`);

    } catch (error) {
        logger.error('Error during initial contact scan', { errorMessage: error.message, errorStack: error.stack });
    } finally {
        isProcessingBatch = false; // Release flag
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

module.exports = {
    startWatcher: attemptStartWatcher, // Export the robust start function
    stopWatcher,
    resetWatcher // Export the new reset function
};
