/**
 * Performance monitoring for voice pipeline optimization
 * Tracks latency at each stage of the pipeline
 */

const logger = require('./logger');
const { featureFlags } = require('../config/featureFlags');

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      stt: [],
      llm: [],
      'llm-first-token': [],
      tts: [],
      transcode: [],
      'first-audio-chunk': [],
      'queue-time': [],
      'barge-in-response': [],
      'deepgram-connect': [],
      'elevenlabs-connect': [],
      'ffmpeg-setup': [],
      total: [],
      cacheHits: 0,
      cacheMisses: 0,
      errors: {}
    };
    
    this.sessionMetrics = new Map();
    this.circuitBreakerFailures = 0;
    this.lastResetTime = Date.now();
  }

  /**
   * Start tracking a new session
   */
  startSession(sessionId) {
    this.sessionMetrics.set(sessionId, {
      startTime: Date.now(),
      stages: {},
      errors: []
    });
  }

  /**
   * Record stage start time
   */
  stageStart(sessionId, stage) {
    const session = this.sessionMetrics.get(sessionId);
    if (session) {
      session.stages[stage] = {
        startTime: Date.now()
      };
    }
  }

  /**
   * Record stage completion and latency
   */
  stageComplete(sessionId, stage, metadata = {}) {
    const session = this.sessionMetrics.get(sessionId);
    if (!session || !session.stages[stage]) return;

    const stageData = session.stages[stage];
    stageData.endTime = Date.now();
    stageData.duration = stageData.endTime - stageData.startTime;
    stageData.metadata = metadata;

    // Store metric
    if (this.metrics[stage]) {
      this.metrics[stage].push(stageData.duration);
      
      // Keep only last 100 measurements
      if (this.metrics[stage].length > 100) {
        this.metrics[stage].shift();
      }
    }

    // Log if enabled
    if (featureFlags.LOG_LATENCY_DETAILS) {
      logger.debug(`Performance: ${stage} completed`, {
        sessionId,
        duration: stageData.duration,
        metadata
      });
    }

    return stageData.duration;
  }

  /**
   * Complete session and calculate total latency
   */
  completeSession(sessionId) {
    const session = this.sessionMetrics.get(sessionId);
    if (!session) return;

    const totalDuration = Date.now() - session.startTime;
    this.metrics.total.push(totalDuration);

    if (this.metrics.total.length > 100) {
      this.metrics.total.shift();
    }

    // Log performance summary
    if (featureFlags.ENABLE_PERFORMANCE_LOGGING) {
      const summary = {
        sessionId,
        totalDuration,
        stages: {}
      };

      for (const [stage, data] of Object.entries(session.stages)) {
        if (data.duration) {
          summary.stages[stage] = data.duration;
        }
      }

      logger.info('Voice pipeline performance summary', summary);

      // Check circuit breaker
      if (featureFlags.ENABLE_CIRCUIT_BREAKER && 
          totalDuration > featureFlags.MAX_ACCEPTABLE_LATENCY) {
        this.circuitBreakerFailures++;
        
        if (this.circuitBreakerFailures >= featureFlags.CIRCUIT_BREAKER_THRESHOLD) {
          logger.error('Circuit breaker triggered - latency threshold exceeded', {
            failures: this.circuitBreakerFailures,
            threshold: featureFlags.CIRCUIT_BREAKER_THRESHOLD
          });
          
          // Trigger optimization rollback
          this.triggerRollback();
        }
      }
    }

    // Clean up session
    this.sessionMetrics.delete(sessionId);
  }

  /**
   * Record cache hit/miss
   */
  recordCacheHit(hit) {
    if (hit) {
      this.metrics.cacheHits++;
    } else {
      this.metrics.cacheMisses++;
    }
  }

  /**
   * Record error
   */
  recordError(sessionId, stage, error) {
    const session = this.sessionMetrics.get(sessionId);
    if (session) {
      session.errors.push({ stage, error: error.message, time: Date.now() });
    }

    if (!this.metrics.errors[stage]) {
      this.metrics.errors[stage] = 0;
    }
    this.metrics.errors[stage]++;
  }

  /**
   * Get performance statistics
   */
  getStats() {
    const stats = {};

    // Calculate averages for each stage
    for (const [stage, measurements] of Object.entries(this.metrics)) {
      if (Array.isArray(measurements) && measurements.length > 0) {
        stats[stage] = {
          avg: this.average(measurements),
          min: Math.min(...measurements),
          max: Math.max(...measurements),
          p95: this.percentile(measurements, 95),
          count: measurements.length
        };
      }
    }

    // Cache statistics
    const totalCacheRequests = this.metrics.cacheHits + this.metrics.cacheMisses;
    if (totalCacheRequests > 0) {
      stats.cacheHitRate = (this.metrics.cacheHits / totalCacheRequests) * 100;
    }

    // Error rates
    stats.errors = this.metrics.errors;

    // Circuit breaker status
    stats.circuitBreaker = {
      failures: this.circuitBreakerFailures,
      threshold: featureFlags.CIRCUIT_BREAKER_THRESHOLD,
      triggered: this.circuitBreakerFailures >= featureFlags.CIRCUIT_BREAKER_THRESHOLD
    };

    return stats;
  }

  /**
   * Reset metrics (hourly)
   */
  reset() {
    const now = Date.now();
    if (now - this.lastResetTime > 3600000) { // 1 hour
      this.metrics = {
        stt: [],
        llm: [],
        tts: [],
        transcode: [],
        total: [],
        cacheHits: 0,
        cacheMisses: 0,
        errors: {}
      };
      this.circuitBreakerFailures = 0;
      this.lastResetTime = now;
      
      logger.info('Performance metrics reset');
    }
  }

  /**
   * Trigger rollback of optimizations
   */
  triggerRollback() {
    logger.error('TRIGGERING OPTIMIZATION ROLLBACK DUE TO PERFORMANCE DEGRADATION');
    
    // This would trigger actual rollback in production
    // For now, just log the event
    // In production, this could:
    // - Disable feature flags
    // - Send alerts
    // - Revert to safe defaults
  }

  // Utility functions
  average(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  percentile(arr, p) {
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index];
  }

  /**
   * Generate detailed latency analysis report
   */
  getDetailedLatencyReport() {
    const stats = this.getStats();
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalSessions: this.sessionMetrics.size,
        lastResetTime: new Date(this.lastResetTime).toISOString(),
        circuitBreakerFailures: this.circuitBreakerFailures
      },
      stages: {},
      analysis: {}
    };

    // Add detailed stage analysis
    const stageOrder = ['stt', 'llm-first-token', 'llm', 'tts', 'transcode', 'first-audio-chunk', 'queue-time', 'barge-in-response'];
    
    for (const stage of stageOrder) {
      if (stats[stage]) {
        report.stages[stage] = {
          ...stats[stage],
          measurements: this.metrics[stage].length
        };
      }
    }

    // Add connection setup metrics
    const connectionStages = ['deepgram-connect', 'elevenlabs-connect', 'ffmpeg-setup'];
    report.connectionSetup = {};
    for (const stage of connectionStages) {
      if (stats[stage]) {
        report.connectionSetup[stage] = stats[stage];
      }
    }

    // Performance analysis
    if (stats.total && stats.total.avg) {
      report.analysis.endToEndLatency = {
        average: stats.total.avg,
        target: '<2000ms',
        status: stats.total.avg < 2000 ? 'GOOD' : stats.total.avg < 3000 ? 'ACCEPTABLE' : 'POOR'
      };
    }

    if (stats['first-audio-chunk'] && stats['first-audio-chunk'].avg) {
      report.analysis.timeToFirstAudio = {
        average: stats['first-audio-chunk'].avg,
        target: '<1500ms',
        status: stats['first-audio-chunk'].avg < 1500 ? 'GOOD' : stats['first-audio-chunk'].avg < 2500 ? 'ACCEPTABLE' : 'POOR'
      };
    }

    if (stats.llm && stats.llm.avg) {
      report.analysis.llmLatency = {
        average: stats.llm.avg,
        target: '<800ms',
        status: stats.llm.avg < 800 ? 'GOOD' : stats.llm.avg < 1200 ? 'ACCEPTABLE' : 'POOR'
      };
    }

    if (stats.tts && stats.tts.avg) {
      report.analysis.ttsLatency = {
        average: stats.tts.avg,
        target: '<500ms',
        status: stats.tts.avg < 500 ? 'GOOD' : stats.tts.avg < 800 ? 'ACCEPTABLE' : 'POOR'
      };
    }

    // Cache performance
    if (stats.cacheHitRate !== undefined) {
      report.analysis.cachePerformance = {
        hitRate: Math.round(stats.cacheHitRate * 100) / 100,
        target: '>70%',
        status: stats.cacheHitRate > 70 ? 'GOOD' : stats.cacheHitRate > 50 ? 'ACCEPTABLE' : 'POOR',
        totalRequests: this.metrics.cacheHits + this.metrics.cacheMisses
      };
    }

    return report;
  }

  /**
   * Log comprehensive latency report
   */
  logLatencyReport() {
    const report = this.getDetailedLatencyReport();
    
    logger.info('=== VOICE PIPELINE LATENCY ANALYSIS ===');
    logger.info('Performance Report', report);
    
    // Log key findings
    if (report.analysis.endToEndLatency) {
      logger.info(`End-to-End Latency: ${Math.round(report.analysis.endToEndLatency.average)}ms (${report.analysis.endToEndLatency.status})`);
    }
    
    if (report.analysis.timeToFirstAudio) {
      logger.info(`Time to First Audio: ${Math.round(report.analysis.timeToFirstAudio.average)}ms (${report.analysis.timeToFirstAudio.status})`);
    }
    
    if (report.analysis.cachePerformance) {
      logger.info(`Cache Hit Rate: ${report.analysis.cachePerformance.hitRate}% (${report.analysis.cachePerformance.status})`);
    }
    
    logger.info('=== END LATENCY ANALYSIS ===');
    
    return report;
  }
}

// Singleton instance
const performanceMonitor = new PerformanceMonitor();

// Reset metrics periodically
setInterval(() => performanceMonitor.reset(), 3600000);

module.exports = performanceMonitor;