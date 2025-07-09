/**
 * WebRTC Service for Real-time Audio Streaming
 * Replaces Twilio recording URLs with real-time audio chunks
 */
const logger = require('../utils/logger');
const EventEmitter = require('events');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');
const path = require('path');

/**
 * WebRTC Audio Streaming Service
 * Handles real-time audio streaming with VAD (Voice Activity Detection)
 */
class WebRTCService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.provider = options.provider || 'daily'; // daily, livekit, etc.
    this.isActive = false;
    this.audioBuffer = [];
    this.vadWorker = null;
    
    // Configuration
    this.config = {
      sampleRate: 16000,
      channels: 1,
      chunkSize: 1024, // 64ms chunks at 16kHz
      vadThreshold: 0.5,
      silenceTimeout: 500, // ms
      maxBufferSize: 32000, // 2 seconds at 16kHz
    };
    
    // Metrics
    this.metrics = {
      chunksReceived: 0,
      speechDetected: 0,
      silenceDetected: 0,
      avgLatency: 0,
      vadAccuracy: 0
    };
  }

  /**
   * Initialize WebRTC connection
   * @param {string} roomId - Room ID for the call
   * @param {object} options - Connection options
   * @returns {Promise<void>}
   */
  async initialize(roomId, options = {}) {
    try {
      logger.info('[WebRTC] Initializing connection', { roomId, provider: this.provider });
      
      // Initialize VAD worker
      this.vadWorker = new Worker(path.join(__dirname, '../workers/vadWorker.js'));
      this.vadWorker.on('message', (result) => {
        this.handleVADResult(result);
      });
      
      // Initialize provider-specific connection
      switch (this.provider) {
        case 'daily':
          await this.initializeDailyConnection(roomId, options);
          break;
        case 'livekit':
          await this.initializeLiveKitConnection(roomId, options);
          break;
        default:
          throw new Error(`Unsupported WebRTC provider: ${this.provider}`);
      }
      
      this.isActive = true;
      logger.info('[WebRTC] Connection initialized successfully');
      
    } catch (error) {
      logger.error('[WebRTC] Failed to initialize connection', { error: error.message });
      throw error;
    }
  }

  /**
   * Initialize Daily.co connection
   * @param {string} roomId - Room ID
   * @param {object} options - Connection options
   */
  async initializeDailyConnection(roomId, options) {
    const DailyIframe = require('@daily-co/daily-js');
    
    this.dailyCall = DailyIframe.createCallObject({
      audioSource: true,
      videoSource: false,
      audioOutput: true
    });
    
    // Set up event handlers
    this.dailyCall.on('joined-meeting', this.handleJoinedMeeting.bind(this));
    this.dailyCall.on('participant-joined', this.handleParticipantJoined.bind(this));
    this.dailyCall.on('track-started', this.handleTrackStarted.bind(this));
    this.dailyCall.on('error', this.handleDailyError.bind(this));
    
    // Join room
    await this.dailyCall.join({
      url: `https://your-domain.daily.co/${roomId}`,
      ...options
    });
  }

  /**
   * Initialize LiveKit connection
   * @param {string} roomId - Room ID
   * @param {object} options - Connection options
   */
  async initializeLiveKitConnection(roomId, options) {
    const { Room, RoomEvent, TrackEvent } = require('livekit-client');
    
    this.livekitRoom = new Room();
    
    // Set up event handlers
    this.livekitRoom.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed.bind(this));
    this.livekitRoom.on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed.bind(this));
    this.livekitRoom.on(RoomEvent.Disconnected, this.handleDisconnected.bind(this));
    
    // Connect to room
    await this.livekitRoom.connect(options.serverUrl, options.token);
  }

  /**
   * Handle audio track data
   * @param {ArrayBuffer} audioData - Raw audio data
   * @param {number} timestamp - Timestamp
   */
  handleAudioData(audioData, timestamp) {
    this.metrics.chunksReceived++;
    
    // Add to buffer
    this.audioBuffer.push({
      data: audioData,
      timestamp: timestamp
    });
    
    // Prevent buffer overflow
    if (this.audioBuffer.length > this.config.maxBufferSize) {
      this.audioBuffer.shift();
    }
    
    // Send to VAD worker
    this.vadWorker.postMessage({
      type: 'process',
      audioData: audioData,
      timestamp: timestamp,
      config: this.config
    });
    
    // Emit raw audio event
    this.emit('audioChunk', {
      data: audioData,
      timestamp: timestamp,
      size: audioData.byteLength
    });
  }

  /**
   * Handle VAD (Voice Activity Detection) result
   * @param {object} result - VAD result
   */
  handleVADResult(result) {
    const { isSpeech, confidence, timestamp } = result;
    
    if (isSpeech) {
      this.metrics.speechDetected++;
      this.emit('speechDetected', {
        confidence,
        timestamp,
        audioData: this.getAudioBufferSince(timestamp - 200) // Include 200ms pre-roll
      });
    } else {
      this.metrics.silenceDetected++;
      this.emit('silenceDetected', {
        confidence,
        timestamp
      });
    }
  }

  /**
   * Get audio buffer since a specific timestamp
   * @param {number} since - Timestamp to start from
   * @returns {ArrayBuffer} - Combined audio data
   */
  getAudioBufferSince(since) {
    const relevantChunks = this.audioBuffer.filter(chunk => chunk.timestamp >= since);
    
    if (relevantChunks.length === 0) {
      return new ArrayBuffer(0);
    }
    
    // Combine audio chunks
    const totalSize = relevantChunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
    const combinedBuffer = new ArrayBuffer(totalSize);
    const view = new Uint8Array(combinedBuffer);
    
    let offset = 0;
    for (const chunk of relevantChunks) {
      view.set(new Uint8Array(chunk.data), offset);
      offset += chunk.data.byteLength;
    }
    
    return combinedBuffer;
  }

  /**
   * Start streaming audio to STT service
   * @param {object} sttService - STT service instance
   */
  startStreamingSTT(sttService) {
    logger.info('[WebRTC] Starting streaming STT');
    
    this.on('speechDetected', async (event) => {
      try {
        const transcription = await sttService.processAudioChunk(event.audioData);
        if (transcription && transcription.text) {
          this.emit('transcriptionReceived', {
            text: transcription.text,
            confidence: transcription.confidence,
            timestamp: event.timestamp
          });
        }
      } catch (error) {
        logger.error('[WebRTC] STT processing error', { error: error.message });
      }
    });
  }

  /**
   * Send audio to the call
   * @param {ArrayBuffer} audioData - Audio data to send
   */
  async sendAudio(audioData) {
    try {
      switch (this.provider) {
        case 'daily':
          if (this.dailyCall) {
            await this.dailyCall.sendAudio(audioData);
          }
          break;
        case 'livekit':
          if (this.livekitRoom) {
            // Implementation depends on LiveKit setup
            logger.debug('[WebRTC] Sending audio via LiveKit');
          }
          break;
      }
    } catch (error) {
      logger.error('[WebRTC] Error sending audio', { error: error.message });
    }
  }

  /**
   * Daily.co event handlers
   */
  handleJoinedMeeting(event) {
    logger.info('[WebRTC] Joined Daily meeting', { participants: event.participants });
    this.emit('connected');
  }

  handleParticipantJoined(event) {
    logger.info('[WebRTC] Participant joined', { participant: event.participant });
  }

  handleTrackStarted(event) {
    logger.info('[WebRTC] Track started', { track: event.track });
    
    if (event.track.kind === 'audio') {
      const audioTrack = event.track;
      
      // Set up audio processing
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
      const processor = audioContext.createScriptProcessor(this.config.chunkSize, 1, 1);
      
      processor.onaudioprocess = (event) => {
        const audioData = event.inputBuffer.getChannelData(0);
        const timestamp = Date.now();
        
        // Convert to ArrayBuffer
        const buffer = new ArrayBuffer(audioData.length * 4);
        const view = new Float32Array(buffer);
        view.set(audioData);
        
        this.handleAudioData(buffer, timestamp);
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
    }
  }

  handleDailyError(event) {
    logger.error('[WebRTC] Daily error', { error: event.error });
    this.emit('error', event.error);
  }

  /**
   * LiveKit event handlers
   */
  handleTrackSubscribed(track, publication, participant) {
    logger.info('[WebRTC] Track subscribed', { track: track.kind, participant: participant.identity });
    
    if (track.kind === 'audio') {
      // Similar audio processing as Daily.co
      this.setupAudioProcessing(track);
    }
  }

  handleTrackUnsubscribed(track, publication, participant) {
    logger.info('[WebRTC] Track unsubscribed', { track: track.kind, participant: participant.identity });
  }

  handleDisconnected() {
    logger.info('[WebRTC] Disconnected from LiveKit room');
    this.emit('disconnected');
  }

  /**
   * Get current metrics
   * @returns {object} - Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      bufferSize: this.audioBuffer.length,
      isActive: this.isActive,
      provider: this.provider
    };
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    logger.info('[WebRTC] Cleaning up resources');
    
    this.isActive = false;
    this.audioBuffer = [];
    
    // Clean up VAD worker
    if (this.vadWorker) {
      this.vadWorker.terminate();
      this.vadWorker = null;
    }
    
    // Clean up provider connections
    try {
      if (this.dailyCall) {
        await this.dailyCall.leave();
        this.dailyCall = null;
      }
      
      if (this.livekitRoom) {
        await this.livekitRoom.disconnect();
        this.livekitRoom = null;
      }
    } catch (error) {
      logger.error('[WebRTC] Error during cleanup', { error: error.message });
    }
    
    this.removeAllListeners();
  }
}

/**
 * Factory function to create WebRTC service
 * @param {object} options - Service options
 * @returns {WebRTCService}
 */
const createWebRTCService = (options = {}) => {
  return new WebRTCService(options);
};

/**
 * Check if WebRTC is enabled
 * @returns {boolean}
 */
const isWebRTCEnabled = () => {
  return process.env.ENABLE_WEBRTC === 'true';
};

module.exports = {
  createWebRTCService,
  WebRTCService,
  isWebRTCEnabled
};