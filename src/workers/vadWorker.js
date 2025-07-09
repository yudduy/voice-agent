/**
 * Voice Activity Detection (VAD) Worker
 * Runs in a separate thread to detect speech vs silence in real-time
 */
const { parentPort } = require('worker_threads');

/**
 * Simple VAD implementation using energy-based detection
 * For production, consider using more sophisticated VAD libraries like:
 * - @tensorflow/tfjs with a trained VAD model
 * - webrtcvad (Python binding)
 * - rnnoise for noise suppression + VAD
 */
class VoiceActivityDetector {
  constructor(config = {}) {
    this.config = {
      sampleRate: config.sampleRate || 16000,
      frameSize: config.frameSize || 1024,
      energyThreshold: config.energyThreshold || 0.01,
      zeroCrossingThreshold: config.zeroCrossingThreshold || 50,
      minSpeechFrames: config.minSpeechFrames || 3,
      minSilenceFrames: config.minSilenceFrames || 5,
      ...config
    };
    
    this.frameBuffer = [];
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
    this.currentState = 'silence'; // 'speech' or 'silence'
    this.previousState = 'silence';
  }

  /**
   * Calculate energy (RMS) of an audio frame
   * @param {Float32Array} frame - Audio frame data
   * @returns {number} - Energy value
   */
  calculateEnergy(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    return Math.sqrt(sum / frame.length);
  }

  /**
   * Calculate zero crossing rate
   * @param {Float32Array} frame - Audio frame data
   * @returns {number} - Zero crossing rate
   */
  calculateZeroCrossingRate(frame) {
    let crossings = 0;
    for (let i = 1; i < frame.length; i++) {
      if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / frame.length;
  }

  /**
   * Apply simple high-pass filter to remove low-frequency noise
   * @param {Float32Array} frame - Audio frame data
   * @returns {Float32Array} - Filtered frame
   */
  applyHighPassFilter(frame) {
    const filtered = new Float32Array(frame.length);
    const alpha = 0.95; // High-pass filter coefficient
    
    filtered[0] = frame[0];
    for (let i = 1; i < frame.length; i++) {
      filtered[i] = alpha * (filtered[i - 1] + frame[i] - frame[i - 1]);
    }
    
    return filtered;
  }

  /**
   * Detect voice activity in an audio frame
   * @param {Float32Array} frame - Audio frame data
   * @returns {object} - VAD result
   */
  detectVoiceActivity(frame) {
    // Apply high-pass filter to reduce noise
    const filteredFrame = this.applyHighPassFilter(frame);
    
    // Calculate features
    const energy = this.calculateEnergy(filteredFrame);
    const zeroCrossingRate = this.calculateZeroCrossingRate(filteredFrame);
    
    // Determine if this frame contains speech
    const isSpeechFrame = energy > this.config.energyThreshold && 
                         zeroCrossingRate > this.config.zeroCrossingThreshold;
    
    // Update frame counters
    if (isSpeechFrame) {
      this.speechFrameCount++;
      this.silenceFrameCount = 0;
    } else {
      this.silenceFrameCount++;
      this.speechFrameCount = 0;
    }
    
    // Update state based on consecutive frames
    this.previousState = this.currentState;
    
    if (this.currentState === 'silence' && this.speechFrameCount >= this.config.minSpeechFrames) {
      this.currentState = 'speech';
    } else if (this.currentState === 'speech' && this.silenceFrameCount >= this.config.minSilenceFrames) {
      this.currentState = 'silence';
    }
    
    // Calculate confidence based on energy and consistency
    const confidence = Math.min(energy / this.config.energyThreshold, 1.0);
    
    return {
      isSpeech: this.currentState === 'speech',
      confidence: confidence,
      energy: energy,
      zeroCrossingRate: zeroCrossingRate,
      stateChanged: this.currentState !== this.previousState,
      frameFeatures: {
        energy,
        zeroCrossingRate,
        speechFrameCount: this.speechFrameCount,
        silenceFrameCount: this.silenceFrameCount
      }
    };
  }

  /**
   * Process audio chunk and return VAD result
   * @param {ArrayBuffer} audioData - Audio data
   * @param {number} timestamp - Timestamp
   * @returns {object} - VAD result
   */
  processAudioChunk(audioData, timestamp) {
    // Convert ArrayBuffer to Float32Array
    const audioArray = new Float32Array(audioData);
    
    // Process in frames
    const results = [];
    for (let i = 0; i < audioArray.length; i += this.config.frameSize) {
      const frame = audioArray.slice(i, i + this.config.frameSize);
      if (frame.length === this.config.frameSize) {
        const result = this.detectVoiceActivity(frame);
        result.timestamp = timestamp + (i / this.config.sampleRate) * 1000; // Convert to ms
        results.push(result);
      }
    }
    
    // Return the most recent result (or aggregate if needed)
    return results.length > 0 ? results[results.length - 1] : null;
  }

  /**
   * Reset VAD state
   */
  reset() {
    this.frameBuffer = [];
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
    this.currentState = 'silence';
    this.previousState = 'silence';
  }
}

// Initialize VAD detector
let vadDetector = null;

// Handle messages from main thread
parentPort.on('message', (message) => {
  const { type, audioData, timestamp, config } = message;
  
  try {
    switch (type) {
      case 'init':
        vadDetector = new VoiceActivityDetector(config);
        parentPort.postMessage({ type: 'initialized', success: true });
        break;
        
      case 'process':
        if (!vadDetector) {
          vadDetector = new VoiceActivityDetector(config);
        }
        
        const result = vadDetector.processAudioChunk(audioData, timestamp);
        if (result) {
          parentPort.postMessage({
            type: 'vad_result',
            ...result
          });
        }
        break;
        
      case 'reset':
        if (vadDetector) {
          vadDetector.reset();
        }
        parentPort.postMessage({ type: 'reset_complete' });
        break;
        
      case 'configure':
        if (vadDetector) {
          vadDetector.config = { ...vadDetector.config, ...config };
        }
        parentPort.postMessage({ type: 'configured' });
        break;
        
      default:
        parentPort.postMessage({ 
          type: 'error', 
          message: `Unknown message type: ${type}` 
        });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error.message,
      stack: error.stack
    });
  }
});

// Handle worker termination
process.on('SIGTERM', () => {
  if (vadDetector) {
    vadDetector.reset();
  }
  process.exit(0);
});

// Send ready signal
parentPort.postMessage({ type: 'ready' });