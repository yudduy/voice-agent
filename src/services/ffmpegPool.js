/**
 * FFmpeg process pooling for efficient audio transcoding
 * Reduces process spawning overhead by maintaining a pool of ready processes
 */

const { spawn } = require('child_process');
const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');
const logger = require('../utils/logger');
const { featureFlags } = require('../config/featureFlags');
const performanceMonitor = require('../utils/performanceMonitor');

class FFmpegPool {
  constructor() {
    this.pool = [];
    this.activeProcesses = new Map();
    this.isInitialized = false;
    
    this.config = {
      poolSize: featureFlags.FFMPEG_POOL_SIZE,
      maxPoolSize: featureFlags.FFMPEG_POOL_SIZE * 2,
      processTimeout: 30000, // 30 seconds
      healthCheckInterval: 60000, // 1 minute
      warmupOnStart: true
    };

    this.stats = {
      created: 0,
      reused: 0,
      errors: 0,
      timeouts: 0
    };
  }

  /**
   * Initialize the FFmpeg pool
   */
  async initialize() {
    if (!featureFlags.ENABLE_FFMPEG_POOLING) {
      logger.info('FFmpeg pooling disabled by feature flag');
      return;
    }

    if (this.isInitialized) return;

    try {
      if (this.config.warmupOnStart) {
        await this.warmupPool();
      }

      // Start health checks
      this.startHealthChecks();
      
      this.isInitialized = true;
      logger.info('FFmpeg pool initialized', {
        poolSize: this.pool.length
      });
    } catch (error) {
      logger.error('Failed to initialize FFmpeg pool', error);
    }
  }

  /**
   * Warmup the pool with pre-spawned processes
   */
  async warmupPool() {
    const promises = [];
    
    for (let i = 0; i < this.config.poolSize; i++) {
      promises.push(this.createProcess());
    }

    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled').length;
    
    logger.info(`FFmpeg pool warmup complete: ${successful}/${this.config.poolSize} processes ready`);
  }

  /**
   * Create a new FFmpeg process
   */
  createProcess() {
    return new Promise((resolve, reject) => {
      performanceMonitor.stageStart('ffmpeg-create', 'process-creation');

      const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'mp3',
        '-i', 'pipe:0',
        '-ar', '8000',
        '-ac', '1',
        '-f', 'mulaw',
        '-c:a', 'pcm_mulaw',
        'pipe:1'
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });

      const processEntry = {
        id: `ffmpeg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        process: ffmpeg,
        inUse: false,
        created: Date.now(),
        lastUsed: null,
        ready: false,
        error: null,
        timeout: null
      };

      // Handle process ready
      ffmpeg.once('spawn', () => {
        processEntry.ready = true;
        this.stats.created++;
        
        performanceMonitor.stageComplete('ffmpeg-create', 'process-creation', {
          processId: processEntry.id
        });
        
        logger.debug(`FFmpeg process ${processEntry.id} ready`);
        resolve(processEntry);
      });

      // Handle errors
      ffmpeg.once('error', (error) => {
        processEntry.ready = false;
        processEntry.error = error;
        this.stats.errors++;
        
        logger.error(`FFmpeg process ${processEntry.id} error:`, error);
        reject(error);
      });

      // Handle unexpected exit
      ffmpeg.once('exit', (code, signal) => {
        if (code !== 0 && !processEntry.inUse) {
          logger.warn(`FFmpeg process ${processEntry.id} exited unexpectedly`, {
            code,
            signal
          });
          
          // Remove from pool
          this.removeFromPool(processEntry);
        }
      });

      // Add to pool
      this.pool.push(processEntry);
      
      // Set timeout for process creation
      setTimeout(() => {
        if (!processEntry.ready) {
          logger.error(`FFmpeg process ${processEntry.id} creation timeout`);
          ffmpeg.kill('SIGKILL');
          reject(new Error('FFmpeg process creation timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Get an available FFmpeg process
   */
  async getProcess() {
    if (!featureFlags.ENABLE_FFMPEG_POOLING) {
      return null; // Caller should create new process
    }

    performanceMonitor.stageStart('ffmpeg-pool', 'process-acquire');

    // Clean up any timed out processes
    this.cleanupTimedOutProcesses();

    // Find available process
    let processEntry = this.pool.find(p => !p.inUse && p.ready && !p.error);
    
    if (!processEntry) {
      logger.debug('No available FFmpeg processes in pool, creating new one');
      
      // Create new process if pool not full
      if (this.pool.length < this.config.maxPoolSize) {
        try {
          processEntry = await this.createProcess();
        } catch (error) {
          logger.error('Failed to create new FFmpeg process', error);
          return null;
        }
      } else {
        // Wait for a process to become available
        processEntry = await this.waitForAvailableProcess();
      }
    }

    if (processEntry) {
      processEntry.inUse = true;
      processEntry.lastUsed = Date.now();
      
      // Set timeout for process usage
      processEntry.timeout = setTimeout(() => {
        logger.warn(`FFmpeg process ${processEntry.id} timed out during use`);
        this.stats.timeouts++;
        this.releaseProcess(processEntry.id, true);
      }, this.config.processTimeout);
      
      // Track active process
      this.activeProcesses.set(processEntry.id, processEntry);
      
      this.stats.reused++;
      
      performanceMonitor.stageComplete('ffmpeg-pool', 'process-acquire', {
        processId: processEntry.id,
        poolSize: this.pool.length,
        reused: true
      });
      
      return processEntry;
    }

    return null;
  }

  /**
   * Create a standalone FFmpeg process (not pooled)
   */
  createStandaloneProcess() {
    performanceMonitor.stageStart('ffmpeg-standalone', 'process-creation');

    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'mp3',
      '-i', 'pipe:0',
      '-ar', '8000',
      '-ac', '1',
      '-f', 'mulaw',
      '-c:a', 'pcm_mulaw',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    performanceMonitor.stageComplete('ffmpeg-standalone', 'process-creation');

    return ffmpeg;
  }

  /**
   * Release a process back to the pool
   */
  releaseProcess(processId, forceKill = false) {
    const processEntry = this.activeProcesses.get(processId);
    if (!processEntry) return;

    // Clear timeout
    if (processEntry.timeout) {
      clearTimeout(processEntry.timeout);
      processEntry.timeout = null;
    }

    // Remove from active processes
    this.activeProcesses.delete(processId);

    if (forceKill || processEntry.error) {
      // Kill and remove process
      logger.debug(`Killing FFmpeg process ${processId}`);
      processEntry.process.kill('SIGKILL');
      this.removeFromPool(processEntry);
      
      // Create replacement if pool below minimum
      if (this.pool.length < this.config.poolSize) {
        this.createProcess().catch(error => {
          logger.error('Failed to create replacement FFmpeg process', error);
        });
      }
    } else {
      // Return to pool for reuse
      processEntry.inUse = false;
      logger.debug(`Released FFmpeg process ${processId} back to pool`);
      
      // Reset stdin/stdout handlers
      processEntry.process.stdin.removeAllListeners();
      processEntry.process.stdout.removeAllListeners();
      processEntry.process.stderr.removeAllListeners();
    }
  }

  /**
   * Wait for an available process
   */
  async waitForAvailableProcess(timeout = 5000) {
    const startTime = Date.now();
    
    while ((Date.now() - startTime) < timeout) {
      const process = this.pool.find(p => !p.inUse && p.ready && !p.error);
      if (process) return process;
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error('No FFmpeg process became available within timeout');
  }

  /**
   * Remove process from pool
   */
  removeFromPool(processEntry) {
    const index = this.pool.indexOf(processEntry);
    if (index > -1) {
      this.pool.splice(index, 1);
    }
  }

  /**
   * Clean up timed out processes
   */
  cleanupTimedOutProcesses() {
    const now = Date.now();
    const timeout = this.config.processTimeout * 2; // Double timeout for cleanup
    
    for (const processEntry of this.pool) {
      if (processEntry.inUse && processEntry.lastUsed && 
          (now - processEntry.lastUsed) > timeout) {
        logger.warn(`Cleaning up timed out FFmpeg process ${processEntry.id}`);
        this.releaseProcess(processEntry.id, true);
      }
    }
  }

  /**
   * Start health checks
   */
  startHealthChecks() {
    setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }

  /**
   * Perform health check on pool
   */
  performHealthCheck() {
    const stats = this.getStats();
    
    logger.debug('FFmpeg pool health check', stats);
    
    // Ensure minimum pool size
    const availableCount = this.pool.filter(p => !p.inUse && p.ready).length;
    
    if (availableCount < Math.floor(this.config.poolSize / 2)) {
      const needed = this.config.poolSize - this.pool.length;
      
      logger.info(`FFmpeg pool below minimum, creating ${needed} new processes`);
      
      for (let i = 0; i < needed; i++) {
        this.createProcess().catch(error => {
          logger.error('Failed to create FFmpeg process during health check', error);
        });
      }
    }
    
    // Clean up old unused processes
    const maxAge = 300000; // 5 minutes
    const now = Date.now();
    
    for (const processEntry of this.pool) {
      if (!processEntry.inUse && processEntry.created && 
          (now - processEntry.created) > maxAge) {
        logger.debug(`Removing old unused FFmpeg process ${processEntry.id}`);
        processEntry.process.kill('SIGKILL');
        this.removeFromPool(processEntry);
      }
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      pool: {
        total: this.pool.length,
        available: this.pool.filter(p => !p.inUse && p.ready).length,
        inUse: this.pool.filter(p => p.inUse).length,
        errors: this.pool.filter(p => p.error).length
      },
      lifetime: {
        created: this.stats.created,
        reused: this.stats.reused,
        errors: this.stats.errors,
        timeouts: this.stats.timeouts
      }
    };
  }

  /**
   * Shutdown the pool
   */
  async shutdown() {
    logger.info('Shutting down FFmpeg pool');
    
    // Kill all processes
    for (const processEntry of this.pool) {
      if (processEntry.timeout) {
        clearTimeout(processEntry.timeout);
      }
      
      processEntry.process.kill('SIGKILL');
    }
    
    this.pool = [];
    this.activeProcesses.clear();
    this.isInitialized = false;
  }
}

// Singleton instance
const ffmpegPool = new FFmpegPool();

module.exports = ffmpegPool;