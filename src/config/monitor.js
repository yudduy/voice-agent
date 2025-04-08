require('dotenv').config();

/**
 * Configuration for the Contact Monitoring Service
 */
module.exports = {
    // Set to true to enable the real-time contact monitor
    enabled: process.env.MONITOR_ENABLED === 'true',

    // Set to true to call immediately upon detection, false to use delay
    immediateCall: process.env.MONITOR_IMMEDIATE_CALL === 'true',

    // Delay in milliseconds before calling a contact (if immediateCall is false)
    callDelayMs: parseInt(process.env.MONITOR_CALL_DELAY_MS || '300000', 10), // Default: 5 minutes (300,000 ms)

    // --- Rate Limiting ---
    // Max number of calls to initiate within the defined interval
    callsPerInterval: parseInt(process.env.MONITOR_RATE_LIMIT_CALLS || '10', 10), // Default: 10 calls...
    // Interval in milliseconds over which the call rate limit applies
    rateLimitIntervalMs: parseInt(process.env.MONITOR_RATE_LIMIT_INTERVAL_MS || '60000', 10), // Default: ...per 60 seconds (60,000 ms)

    // --- Initial Scan ---
    // Number of contacts to fetch and process in each batch during the initial scan
    batchSize: parseInt(process.env.MONITOR_BATCH_SIZE || '50', 10) // Default: 50 contacts per batch
};
