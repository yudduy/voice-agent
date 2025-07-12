/**
 * WebSocket connection pooling for Deepgram and ElevenLabs
 * Reduces connection setup latency by maintaining persistent connections
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const WebSocket = require('ws');
const logger = require('../utils/logger');
const { featureFlags } = require('../config/featureFlags');
const performanceMonitor = require('../utils/performanceMonitor');

class ConnectionPool {
  constructor() {
    this.deepgramPool = [];
    this.elevenLabsPool = [];
    this.deepgramClient = null;
    this.isInitialized = false;
    
    // Configuration
    this.config = {
      deepgramPoolSize: featureFlags.WEBSOCKET_POOL_SIZE,
      elevenLabsPoolSize: featureFlags.WEBSOCKET_POOL_SIZE,
      connectionTimeout: 5000,
      healthCheckInterval: 30000,
      reconnectDelay: 1000,
      maxReconnectAttempts: 3
    };
  }

  /**
   * Initialize the connection pool
   */
  async initialize() {
    if (!featureFlags.ENABLE_WEBSOCKET_POOLING) {
      logger.info('WebSocket pooling disabled by feature flag');
      return;
    }

    if (this.isInitialized) return;

    try {
      // Initialize Deepgram client
      if (process.env.DEEPGRAM_API_KEY) {
        this.deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
        await this.warmupDeepgramConnections();
      }

      // Initialize ElevenLabs connections
      if (process.env.ELEVENLABS_API_KEY) {
        await this.warmupElevenLabsConnections();
      }

      // Start health checks
      this.startHealthChecks();
      
      this.isInitialized = true;
      logger.info('Connection pool initialized', {
        deepgramPoolSize: this.deepgramPool.length,
        elevenLabsPoolSize: this.elevenLabsPool.length
      });
    } catch (error) {
      logger.error('Failed to initialize connection pool', error);
    }
  }

  /**
   * Warmup Deepgram connections
   */
  async warmupDeepgramConnections() {
    const promises = [];
    
    for (let i = 0; i < this.config.deepgramPoolSize; i++) {
      promises.push(this.createDeepgramConnection(i));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Create a new Deepgram connection
   */
  async createDeepgramConnection(poolIndex) {
    try {
      const connection = this.deepgramClient.listen.live({
        model: 'nova-2',
        language: 'en-US',
        punctuate: true,
        smart_format: true,
        profanity_filter: false,
        endpointing: featureFlags.ENABLE_OPTIMIZED_VAD ? 
          featureFlags.VAD_ENDPOINTING_MS : 450,
        utterance_end_ms: featureFlags.ENABLE_OPTIMIZED_VAD ? 
          featureFlags.VAD_UTTERANCE_END_MS : 1000,
        vad_events: true,
        interim_results: true
      });

      const poolEntry = {
        id: `deepgram-${poolIndex}`,
        connection,
        inUse: false,
        created: Date.now(),
        lastUsed: null,
        reconnectAttempts: 0,
        ready: false
      };

      // Setup event handlers
      connection.on(LiveTranscriptionEvents.Open, () => {
        poolEntry.ready = true;
        logger.debug(`Deepgram connection ${poolEntry.id} ready`);
      });

      connection.on(LiveTranscriptionEvents.Error, (error) => {
        logger.error(`Deepgram connection ${poolEntry.id} error:`, error);
        poolEntry.ready = false;
        this.handleConnectionError(poolEntry, 'deepgram');
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        logger.debug(`Deepgram connection ${poolEntry.id} closed`);
        poolEntry.ready = false;
      });

      this.deepgramPool.push(poolEntry);
      
      // Wait for connection to be ready
      await this.waitForConnection(poolEntry, 'deepgram');
      
      return poolEntry;
    } catch (error) {
      logger.error('Failed to create Deepgram connection', error);
      throw error;
    }
  }

  /**
   * Warmup ElevenLabs connections
   */
  async warmupElevenLabsConnections() {
    const promises = [];
    
    for (let i = 0; i < this.config.elevenLabsPoolSize; i++) {
      promises.push(this.createElevenLabsConnection(i));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Create a new ElevenLabs connection
   */
  async createElevenLabsConnection(poolIndex) {
    try {
      const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
      const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2`;
      
      const connection = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY
        }
      });

      const poolEntry = {
        id: `elevenlabs-${poolIndex}`,
        connection,
        inUse: false,
        created: Date.now(),
        lastUsed: null,
        reconnectAttempts: 0,
        ready: false,
        voiceId
      };

      // Setup event handlers
      connection.on('open', () => {
        poolEntry.ready = true;
        logger.debug(`ElevenLabs connection ${poolEntry.id} ready`);
        
        // Send initial configuration
        connection.send(JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            use_speaker_boost: true
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290]
          }
        }));
      });

      connection.on('error', (error) => {
        logger.error(`ElevenLabs connection ${poolEntry.id} error:`, error);
        poolEntry.ready = false;
        this.handleConnectionError(poolEntry, 'elevenlabs');
      });

      connection.on('close', () => {
        logger.debug(`ElevenLabs connection ${poolEntry.id} closed`);
        poolEntry.ready = false;
      });

      this.elevenLabsPool.push(poolEntry);
      
      // Wait for connection to be ready
      await this.waitForConnection(poolEntry, 'elevenlabs');
      
      return poolEntry;
    } catch (error) {
      logger.error('Failed to create ElevenLabs connection', error);
      throw error;
    }
  }

  /**
   * Wait for connection to be ready
   */
  async waitForConnection(poolEntry, type, timeout = 5000) {
    const startTime = Date.now();
    
    while (!poolEntry.ready && (Date.now() - startTime) < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (!poolEntry.ready) {
      throw new Error(`${type} connection ${poolEntry.id} failed to become ready`);
    }
  }

  /**
   * Get an available Deepgram connection
   */
  async getDeepgramConnection() {
    if (!featureFlags.ENABLE_WEBSOCKET_POOLING) {
      return null; // Caller should create new connection
    }

    performanceMonitor.stageStart('pool-deepgram', 'connection-acquire');

    // Find available connection
    let connection = this.deepgramPool.find(c => !c.inUse && c.ready);
    
    if (!connection) {
      logger.warn('No available Deepgram connections in pool');
      
      // Try to create a new one if pool not full
      if (this.deepgramPool.length < this.config.deepgramPoolSize * 2) {
        connection = await this.createDeepgramConnection(this.deepgramPool.length);
      } else {
        // Wait for a connection to become available
        connection = await this.waitForAvailableConnection('deepgram');
      }
    }

    if (connection) {
      connection.inUse = true;
      connection.lastUsed = Date.now();
      
      performanceMonitor.stageComplete('pool-deepgram', 'connection-acquire', {
        connectionId: connection.id,
        poolSize: this.deepgramPool.length
      });
    }

    return connection;
  }

  /**
   * Get an available ElevenLabs connection
   */
  async getElevenLabsConnection() {
    if (!featureFlags.ENABLE_WEBSOCKET_POOLING) {
      return null; // Caller should create new connection
    }

    performanceMonitor.stageStart('pool-elevenlabs', 'connection-acquire');

    // Find available connection
    let connection = this.elevenLabsPool.find(c => !c.inUse && c.ready);
    
    if (!connection) {
      logger.warn('No available ElevenLabs connections in pool');
      
      // Try to create a new one if pool not full
      if (this.elevenLabsPool.length < this.config.elevenLabsPoolSize * 2) {
        connection = await this.createElevenLabsConnection(this.elevenLabsPool.length);
      } else {
        // Wait for a connection to become available
        connection = await this.waitForAvailableConnection('elevenlabs');
      }
    }

    if (connection) {
      connection.inUse = true;
      connection.lastUsed = Date.now();
      
      performanceMonitor.stageComplete('pool-elevenlabs', 'connection-acquire', {
        connectionId: connection.id,
        poolSize: this.elevenLabsPool.length
      });
    }

    return connection;
  }

  /**
   * Release a connection back to the pool
   */
  releaseConnection(connection, type) {
    if (!connection) return;

    connection.inUse = false;
    
    logger.debug(`Released ${type} connection ${connection.id} back to pool`);
  }

  /**
   * Wait for an available connection
   */
  async waitForAvailableConnection(type, timeout = 5000) {
    const startTime = Date.now();
    const pool = type === 'deepgram' ? this.deepgramPool : this.elevenLabsPool;
    
    while ((Date.now() - startTime) < timeout) {
      const connection = pool.find(c => !c.inUse && c.ready);
      if (connection) return connection;
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    throw new Error(`No ${type} connection became available within timeout`);
  }

  /**
   * Handle connection errors
   */
  async handleConnectionError(poolEntry, type) {
    poolEntry.reconnectAttempts++;
    
    if (poolEntry.reconnectAttempts > this.config.maxReconnectAttempts) {
      logger.error(`Removing failed ${type} connection ${poolEntry.id} from pool`);
      
      // Remove from pool
      const pool = type === 'deepgram' ? this.deepgramPool : this.elevenLabsPool;
      const index = pool.indexOf(poolEntry);
      if (index > -1) {
        pool.splice(index, 1);
      }
      
      // Create replacement
      try {
        if (type === 'deepgram') {
          await this.createDeepgramConnection(pool.length);
        } else {
          await this.createElevenLabsConnection(pool.length);
        }
      } catch (error) {
        logger.error(`Failed to create replacement ${type} connection`, error);
      }
    } else {
      // Schedule reconnection
      setTimeout(() => {
        this.reconnectConnection(poolEntry, type);
      }, this.config.reconnectDelay * poolEntry.reconnectAttempts);
    }
  }

  /**
   * Reconnect a failed connection
   */
  async reconnectConnection(poolEntry, type) {
    logger.info(`Attempting to reconnect ${type} connection ${poolEntry.id}`);
    
    try {
      if (type === 'deepgram') {
        // Close existing connection
        if (poolEntry.connection) {
          poolEntry.connection.removeAllListeners();
          poolEntry.connection.finish();
        }
        
        // Create new connection with same pool index
        const index = this.deepgramPool.indexOf(poolEntry);
        if (index > -1) {
          this.deepgramPool.splice(index, 1);
          await this.createDeepgramConnection(index);
        }
      } else {
        // Close existing connection
        if (poolEntry.connection) {
          poolEntry.connection.removeAllListeners();
          poolEntry.connection.close();
        }
        
        // Create new connection with same pool index
        const index = this.elevenLabsPool.indexOf(poolEntry);
        if (index > -1) {
          this.elevenLabsPool.splice(index, 1);
          await this.createElevenLabsConnection(index);
        }
      }
    } catch (error) {
      logger.error(`Failed to reconnect ${type} connection ${poolEntry.id}`, error);
    }
  }

  /**
   * Start health checks for all connections
   */
  startHealthChecks() {
    setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);
  }

  /**
   * Perform health checks on all connections
   */
  async performHealthChecks() {
    // Check Deepgram connections
    for (const connection of this.deepgramPool) {
      if (!connection.inUse && connection.connection) {
        const isHealthy = connection.connection.getReadyState() === 1;
        
        if (!isHealthy) {
          logger.warn(`Deepgram connection ${connection.id} unhealthy`);
          connection.ready = false;
          await this.handleConnectionError(connection, 'deepgram');
        }
      }
    }

    // Check ElevenLabs connections
    for (const connection of this.elevenLabsPool) {
      if (!connection.inUse && connection.connection) {
        const isHealthy = connection.connection.readyState === WebSocket.OPEN;
        
        if (!isHealthy) {
          logger.warn(`ElevenLabs connection ${connection.id} unhealthy`);
          connection.ready = false;
          await this.handleConnectionError(connection, 'elevenlabs');
        }
      }
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      deepgram: {
        total: this.deepgramPool.length,
        available: this.deepgramPool.filter(c => !c.inUse && c.ready).length,
        inUse: this.deepgramPool.filter(c => c.inUse).length,
        unhealthy: this.deepgramPool.filter(c => !c.ready).length
      },
      elevenlabs: {
        total: this.elevenLabsPool.length,
        available: this.elevenLabsPool.filter(c => !c.inUse && c.ready).length,
        inUse: this.elevenLabsPool.filter(c => c.inUse).length,
        unhealthy: this.elevenLabsPool.filter(c => !c.ready).length
      }
    };
  }

  /**
   * Shutdown the connection pool
   */
  async shutdown() {
    logger.info('Shutting down connection pool');
    
    // Close all Deepgram connections
    for (const connection of this.deepgramPool) {
      if (connection.connection) {
        connection.connection.removeAllListeners();
        connection.connection.finish();
      }
    }
    
    // Close all ElevenLabs connections
    for (const connection of this.elevenLabsPool) {
      if (connection.connection) {
        connection.connection.removeAllListeners();
        connection.connection.close();
      }
    }
    
    this.deepgramPool = [];
    this.elevenLabsPool = [];
    this.isInitialized = false;
  }
}

// Singleton instance
const connectionPool = new ConnectionPool();

module.exports = connectionPool;