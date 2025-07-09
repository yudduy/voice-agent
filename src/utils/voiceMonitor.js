/**
 * Voice Service Monitoring Utility
 * 
 * Tracks performance metrics for TTS requests handled by voiceService.js.
 */
const logger = require('./logger');
const { cache: cacheConfig } = require('../config');

const MAX_HISTORY = cacheConfig.voiceMonitor.maxHistory;

const metrics = {
  ttsRequests: 0,    // Total requests handled by generateSpeech (including cache checks)
  ttsSuccess: 0,     // Successful TTS generations (API call successful)
  ttsFailed: 0,      // Failed TTS generations (API call failed)
  cacheHits: 0,      // Requests served directly from cache
  responseTimes: [], // Array to store last N successful TTS API response times (ms)
  audioSizes: []       // Array to store last N generated audio sizes (bytes)
};

/**
 * Helper to calculate the average of an array of numbers.
 * @param {number[]} arr 
 * @returns {number} Average or 0 if array is empty.
 */
function calculateAverage(arr) {
  if (!arr || arr.length === 0) {
    return 0;
  }
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / arr.length;
}

/**
 * Records a specific performance metric.
 * @param {'ttsRequest'|'ttsSuccess'|'ttsFailure'|'cacheHit'|'responseTime'|'audioSize'} type - The type of metric.
 * @param {*} [value] - The value associated with the metric (e.g., time in ms, size in bytes).
 */
function recordMetric(type, value) {
  try {
    switch (type) {
      case 'ttsRequest':
        metrics.ttsRequests++;
        break;
      case 'ttsSuccess':
        metrics.ttsSuccess++;
        // Response time and audio size are recorded separately when success occurs
        break;
      case 'ttsFailure':
        metrics.ttsFailed++;
        break;
      case 'cacheHit':
        metrics.cacheHits++;
        break;
      case 'responseTime':
        if (typeof value === 'number' && value >= 0) {
          metrics.responseTimes.push(value);
          // Keep only the last MAX_HISTORY entries
          if (metrics.responseTimes.length > MAX_HISTORY) {
            metrics.responseTimes.shift(); 
          }
        }
        break;
      case 'audioSize':
        if (typeof value === 'number' && value >= 0) {
          metrics.audioSizes.push(value);
          // Keep only the last MAX_HISTORY entries
          if (metrics.audioSizes.length > MAX_HISTORY) {
            metrics.audioSizes.shift();
          }
        }
        break;
      default:
        logger.warn('[VoiceMonitor] Unknown metric type:', type);
    }
  } catch (error) {
      logger.error('[VoiceMonitor] Error recording metric', { type, value, error: error.message });
  }
}

/**
 * Calculates and returns a summary of the current performance metrics.
 * @returns {object} Summary object with calculated metrics.
 */
function getMetricsSummary() {
  const totalRequests = metrics.ttsRequests;
  const apiAttempts = totalRequests - metrics.cacheHits; // Requests that actually hit the API

  // Ensure division by zero doesn't happen
  const successRate = apiAttempts > 0 ? (metrics.ttsSuccess / apiAttempts) : (totalRequests === 0 ? 1 : 0); // If no attempts, rate is irrelevant (or 100% if only cache hits)
  const cacheHitRatio = totalRequests > 0 ? (metrics.cacheHits / totalRequests) : 0;
  
  // Calculate averages based on the stored history
  const averageResponseTime = calculateAverage(metrics.responseTimes);
  const averageAudioSize = calculateAverage(metrics.audioSizes);

  return {
    totalRequests: totalRequests,
    cacheHits: metrics.cacheHits,
    cacheHitRatio: cacheHitRatio,
    apiAttempts: apiAttempts,
    apiSuccess: metrics.ttsSuccess,
    apiFailed: metrics.ttsFailed,
    apiSuccessRate: successRate, // Success rate of actual API calls
    averageResponseTimeMs: averageResponseTime, // Avg response time for successful API calls
    averageAudioSizeBytes: averageAudioSize,    // Avg size for successful API calls
    // Raw counts can be useful too
    // _rawCounts: { ...metrics } // Uncomment if needed for deeper debugging
  };
}

module.exports = {
  recordMetric,
  getMetricsSummary
}; 