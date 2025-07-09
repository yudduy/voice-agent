/**
 * Speculative Execution Engine
 * Handles partial STT input processing with dynamic correction and response pivoting
 */
const logger = require('../utils/logger');
const EventEmitter = require('events');
const { distance } = require('fastest-levenshtein');

/**
 * Speculative execution states
 */
const SPECULATION_STATES = {
  IDLE: 'idle',
  WAITING: 'waiting',
  SPECULATING: 'speculating',
  CONFIRMED: 'confirmed',
  CORRECTING: 'correcting',
  FAILED: 'failed'
};

/**
 * Speculative Execution Engine
 * Manages partial input processing and response correction
 */
class SpeculativeEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.config = {
      minSpeculationLength: options.minSpeculationLength || 15,
      maxSpeculationLength: options.maxSpeculationLength || 50,
      correctionThreshold: options.correctionThreshold || 0.3, // 30% difference triggers correction
      confidenceThreshold: options.confidenceThreshold || 0.7,
      speculationTimeout: options.speculationTimeout || 2000, // 2 seconds max speculation
      pivotTimeout: options.pivotTimeout || 100, // 100ms to pivot response
      ...options
    };
    
    // Current speculation state
    this.currentSpeculation = {
      state: SPECULATION_STATES.IDLE,
      partialInput: '',
      finalInput: '',
      confidence: 0,
      startTime: null,
      streamId: null,
      abortController: null,
      generatedTokens: [],
      pivotGeneration: null
    };
    
    // Metrics
    this.metrics = {
      totalSpeculations: 0,
      successfulSpeculations: 0,
      failedSpeculations: 0,
      corrections: 0,
      pivots: 0,
      avgSpeculationTime: 0,
      avgCorrectionTime: 0
    };
    
    // Common word patterns for better speculation
    this.commonPatterns = {
      questions: ['what', 'how', 'when', 'where', 'why', 'who', 'can you', 'could you', 'do you'],
      requests: ['please', 'i need', 'i want', 'help me', 'show me', 'tell me'],
      commands: ['schedule', 'cancel', 'create', 'delete', 'update', 'send', 'call', 'text']
    };
    
    // Intent prediction cache
    this.intentCache = new Map();
  }

  /**
   * Process partial STT input and determine if speculation should start
   * @param {string} partialInput - Partial transcription
   * @param {number} confidence - STT confidence score
   * @param {boolean} isComplete - Whether this is the final transcription
   * @returns {Promise<object>} - Speculation decision
   */
  async processPartialInput(partialInput, confidence = 1.0, isComplete = false) {
    const startTime = Date.now();
    
    logger.debug('[SpeculativeEngine] Processing partial input', {
      partialInput: partialInput.substring(0, 30) + '...',
      confidence,
      isComplete,
      currentState: this.currentSpeculation.state,
      length: partialInput.length
    });
    
    // Handle complete input
    if (isComplete) {
      return await this.handleCompleteInput(partialInput, confidence);
    }
    
    // Handle partial input
    return await this.handlePartialInput(partialInput, confidence);
  }

  /**
   * Handle partial STT input
   * @param {string} partialInput - Partial transcription
   * @param {number} confidence - STT confidence score
   * @returns {Promise<object>} - Speculation result
   */
  async handlePartialInput(partialInput, confidence) {
    const trimmedInput = partialInput.trim();
    
    // Check if we should start speculation
    if (this.shouldStartSpeculation(trimmedInput, confidence)) {
      return await this.startSpeculation(trimmedInput, confidence);
    }
    
    // Update existing speculation
    if (this.currentSpeculation.state === SPECULATION_STATES.SPECULATING) {
      return await this.updateSpeculation(trimmedInput, confidence);
    }
    
    // Not ready for speculation
    return {
      shouldSpeculate: false,
      state: this.currentSpeculation.state,
      reason: 'Insufficient input or confidence'
    };
  }

  /**
   * Handle complete STT input
   * @param {string} finalInput - Final transcription
   * @param {number} confidence - STT confidence score
   * @returns {Promise<object>} - Correction result
   */
  async handleCompleteInput(finalInput, confidence) {
    const trimmedInput = finalInput.trim();
    
    if (this.currentSpeculation.state === SPECULATION_STATES.SPECULATING) {
      return await this.validateSpeculation(trimmedInput, confidence);
    }
    
    // No active speculation - process normally
    return {
      shouldSpeculate: false,
      requiresCorrection: false,
      finalInput: trimmedInput,
      confidence,
      state: SPECULATION_STATES.CONFIRMED
    };
  }

  /**
   * Determine if speculation should start
   * @param {string} input - Input text
   * @param {number} confidence - STT confidence
   * @returns {boolean}
   */
  shouldStartSpeculation(input, confidence) {
    // Check minimum requirements
    if (input.length < this.config.minSpeculationLength) {
      return false;
    }
    
    if (confidence < this.config.confidenceThreshold) {
      return false;
    }
    
    if (this.currentSpeculation.state !== SPECULATION_STATES.IDLE) {
      return false;
    }
    
    // Check if input contains actionable intent
    const hasActionableIntent = this.detectActionableIntent(input);
    if (!hasActionableIntent) {
      return false;
    }
    
    return true;
  }

  /**
   * Start speculative execution
   * @param {string} partialInput - Partial input
   * @param {number} confidence - STT confidence
   * @returns {Promise<object>} - Speculation result
   */
  async startSpeculation(partialInput, confidence) {
    const startTime = Date.now();
    
    logger.info('[SpeculativeEngine] Starting speculation', {
      partialInput: partialInput.substring(0, 30) + '...',
      confidence,
      length: partialInput.length
    });
    
    // Update speculation state
    this.currentSpeculation = {
      state: SPECULATION_STATES.SPECULATING,
      partialInput,
      finalInput: '',
      confidence,
      startTime,
      streamId: `spec_${Date.now()}`,
      abortController: new AbortController(),
      generatedTokens: [],
      pivotGeneration: null
    };
    
    // Predict likely completion
    const predictedCompletion = await this.predictCompletion(partialInput);
    
    // Update metrics
    this.metrics.totalSpeculations++;
    
    // Emit speculation start event
    this.emit('speculationStarted', {
      partialInput,
      predictedCompletion,
      streamId: this.currentSpeculation.streamId,
      confidence
    });
    
    return {
      shouldSpeculate: true,
      streamId: this.currentSpeculation.streamId,
      predictedCompletion,
      abortController: this.currentSpeculation.abortController,
      state: SPECULATION_STATES.SPECULATING
    };
  }

  /**
   * Update ongoing speculation
   * @param {string} partialInput - Updated partial input
   * @param {number} confidence - STT confidence
   * @returns {Promise<object>} - Update result
   */
  async updateSpeculation(partialInput, confidence) {
    if (this.currentSpeculation.state !== SPECULATION_STATES.SPECULATING) {
      return { shouldSpeculate: false, reason: 'Not in speculation state' };
    }
    
    // Calculate difference from initial speculation
    const similarity = this.calculateSimilarity(
      this.currentSpeculation.partialInput,
      partialInput
    );
    
    logger.debug('[SpeculativeEngine] Updating speculation', {
      originalInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      newInput: partialInput.substring(0, 30) + '...',
      similarity,
      confidence
    });
    
    // If input has changed significantly, consider pivoting
    if (similarity < (1 - this.config.correctionThreshold)) {
      return await this.considerPivot(partialInput, confidence);
    }
    
    // Update speculation state
    this.currentSpeculation.partialInput = partialInput;
    this.currentSpeculation.confidence = Math.min(this.currentSpeculation.confidence, confidence);
    
    return {
      shouldSpeculate: true,
      streamId: this.currentSpeculation.streamId,
      similarity,
      state: SPECULATION_STATES.SPECULATING
    };
  }

  /**
   * Validate speculation against final input
   * @param {string} finalInput - Final transcription
   * @param {number} confidence - STT confidence
   * @returns {Promise<object>} - Validation result
   */
  async validateSpeculation(finalInput, confidence) {
    const startTime = Date.now();
    
    logger.info('[SpeculativeEngine] Validating speculation', {
      partialInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      finalInput: finalInput.substring(0, 30) + '...',
      confidence
    });
    
    // Calculate similarity between speculation and final input
    const similarity = this.calculateSimilarity(
      this.currentSpeculation.partialInput,
      finalInput
    );
    
    const needsCorrection = similarity < (1 - this.config.correctionThreshold);
    
    // Update final input
    this.currentSpeculation.finalInput = finalInput;
    
    if (needsCorrection) {
      // Correction needed
      return await this.handleCorrection(finalInput, confidence, similarity);
    } else {
      // Speculation was successful
      return await this.confirmSpeculation(finalInput, confidence, similarity);
    }
  }

  /**
   * Handle speculation correction
   * @param {string} finalInput - Final input
   * @param {number} confidence - STT confidence
   * @param {number} similarity - Similarity score
   * @returns {Promise<object>} - Correction result
   */
  async handleCorrection(finalInput, confidence, similarity) {
    const correctionStartTime = Date.now();
    
    logger.warn('[SpeculativeEngine] Correction needed', {
      partialInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      finalInput: finalInput.substring(0, 30) + '...',
      similarity,
      confidence
    });
    
    // Update state
    this.currentSpeculation.state = SPECULATION_STATES.CORRECTING;
    
    // Abort current speculation
    if (this.currentSpeculation.abortController) {
      this.currentSpeculation.abortController.abort();
    }
    
    // Determine correction strategy
    const correctionStrategy = this.determineCorrectionStrategy(
      this.currentSpeculation.partialInput,
      finalInput,
      similarity
    );
    
    // Update metrics
    this.metrics.corrections++;
    this.metrics.failedSpeculations++;
    
    // Emit correction event
    this.emit('speculationCorrected', {
      partialInput: this.currentSpeculation.partialInput,
      finalInput,
      similarity,
      correctionStrategy,
      streamId: this.currentSpeculation.streamId,
      correctionTime: Date.now() - correctionStartTime
    });
    
    // Reset speculation state
    this.resetSpeculation();
    
    return {
      requiresCorrection: true,
      correctionStrategy,
      finalInput,
      similarity,
      correctionTime: Date.now() - correctionStartTime,
      state: SPECULATION_STATES.FAILED
    };
  }

  /**
   * Confirm successful speculation
   * @param {string} finalInput - Final input
   * @param {number} confidence - STT confidence
   * @param {number} similarity - Similarity score
   * @returns {Promise<object>} - Confirmation result
   */
  async confirmSpeculation(finalInput, confidence, similarity) {
    const speculationTime = Date.now() - this.currentSpeculation.startTime;
    
    logger.info('[SpeculativeEngine] Speculation confirmed', {
      partialInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      finalInput: finalInput.substring(0, 30) + '...',
      similarity,
      speculationTime
    });
    
    // Update state
    this.currentSpeculation.state = SPECULATION_STATES.CONFIRMED;
    
    // Update metrics
    this.metrics.successfulSpeculations++;
    this.updateAverageSpeculationTime(speculationTime);
    
    // Emit confirmation event
    this.emit('speculationConfirmed', {
      partialInput: this.currentSpeculation.partialInput,
      finalInput,
      similarity,
      speculationTime,
      streamId: this.currentSpeculation.streamId
    });
    
    // Reset speculation state
    this.resetSpeculation();
    
    return {
      requiresCorrection: false,
      finalInput,
      similarity,
      speculationTime,
      state: SPECULATION_STATES.CONFIRMED
    };
  }

  /**
   * Consider pivoting during speculation
   * @param {string} newInput - New partial input
   * @param {number} confidence - STT confidence
   * @returns {Promise<object>} - Pivot decision
   */
  async considerPivot(newInput, confidence) {
    const pivotStartTime = Date.now();
    
    logger.debug('[SpeculativeEngine] Considering pivot', {
      originalInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      newInput: newInput.substring(0, 30) + '...',
      confidence
    });
    
    // Check if pivot is worth it
    const pivotConfidence = this.calculatePivotConfidence(
      this.currentSpeculation.partialInput,
      newInput
    );
    
    if (pivotConfidence > 0.8) {
      // Perform pivot
      return await this.performPivot(newInput, confidence);
    }
    
    // Continue with current speculation
    return {
      shouldSpeculate: true,
      pivotConsidered: true,
      pivotConfidence,
      streamId: this.currentSpeculation.streamId,
      state: SPECULATION_STATES.SPECULATING
    };
  }

  /**
   * Perform speculation pivot
   * @param {string} newInput - New input to pivot to
   * @param {number} confidence - STT confidence
   * @returns {Promise<object>} - Pivot result
   */
  async performPivot(newInput, confidence) {
    const pivotStartTime = Date.now();
    
    logger.info('[SpeculativeEngine] Performing pivot', {
      originalInput: this.currentSpeculation.partialInput.substring(0, 30) + '...',
      newInput: newInput.substring(0, 30) + '...',
      confidence
    });
    
    // Abort current speculation
    if (this.currentSpeculation.abortController) {
      this.currentSpeculation.abortController.abort();
    }
    
    // Create new speculation
    const newStreamId = `pivot_${Date.now()}`;
    const newAbortController = new AbortController();
    
    // Update speculation state
    this.currentSpeculation.partialInput = newInput;
    this.currentSpeculation.confidence = confidence;
    this.currentSpeculation.streamId = newStreamId;
    this.currentSpeculation.abortController = newAbortController;
    this.currentSpeculation.pivotGeneration = {
      startTime: pivotStartTime,
      originalInput: this.currentSpeculation.partialInput,
      newInput
    };
    
    // Update metrics
    this.metrics.pivots++;
    
    // Emit pivot event
    this.emit('speculationPivoted', {
      originalInput: this.currentSpeculation.partialInput,
      newInput,
      newStreamId,
      abortController: newAbortController,
      pivotTime: Date.now() - pivotStartTime
    });
    
    return {
      shouldSpeculate: true,
      pivoted: true,
      newStreamId,
      abortController: newAbortController,
      pivotTime: Date.now() - pivotStartTime,
      state: SPECULATION_STATES.SPECULATING
    };
  }

  /**
   * Detect actionable intent in input
   * @param {string} input - Input text
   * @returns {boolean} - Has actionable intent
   */
  detectActionableIntent(input) {
    const lowerInput = input.toLowerCase();
    
    // Check for question patterns
    const hasQuestion = this.commonPatterns.questions.some(pattern => 
      lowerInput.includes(pattern)
    );
    
    // Check for request patterns
    const hasRequest = this.commonPatterns.requests.some(pattern => 
      lowerInput.includes(pattern)
    );
    
    // Check for command patterns
    const hasCommand = this.commonPatterns.commands.some(pattern => 
      lowerInput.includes(pattern)
    );
    
    return hasQuestion || hasRequest || hasCommand;
  }

  /**
   * Predict likely completion for partial input
   * @param {string} partialInput - Partial input
   * @returns {Promise<string>} - Predicted completion
   */
  async predictCompletion(partialInput) {
    // Simple prediction based on common patterns
    const lowerInput = partialInput.toLowerCase();
    
    // Check cache first
    const cacheKey = lowerInput.substring(0, 20);
    if (this.intentCache.has(cacheKey)) {
      return this.intentCache.get(cacheKey);
    }
    
    let prediction = partialInput;
    
    // Add common completions
    if (lowerInput.includes('can you')) {
      prediction += ' help me with';
    } else if (lowerInput.includes('what')) {
      prediction += ' is';
    } else if (lowerInput.includes('how')) {
      prediction += ' do I';
    } else if (lowerInput.includes('schedule')) {
      prediction += ' a meeting';
    }
    
    // Cache prediction
    this.intentCache.set(cacheKey, prediction);
    
    return prediction;
  }

  /**
   * Calculate similarity between two strings
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} - Similarity score (0-1)
   */
  calculateSimilarity(str1, str2) {
    const maxLength = Math.max(str1.length, str2.length);
    if (maxLength === 0) return 1.0;
    
    const editDistance = distance(str1.toLowerCase(), str2.toLowerCase());
    return 1 - (editDistance / maxLength);
  }

  /**
   * Calculate confidence for pivoting
   * @param {string} originalInput - Original input
   * @param {string} newInput - New input
   * @returns {number} - Pivot confidence (0-1)
   */
  calculatePivotConfidence(originalInput, newInput) {
    // Simple heuristic: if new input is significantly longer and contains more words
    const originalWords = originalInput.split(' ').length;
    const newWords = newInput.split(' ').length;
    
    if (newWords > originalWords * 1.5) {
      return 0.9;
    }
    
    // Check for intent changes
    const originalIntent = this.detectIntent(originalInput);
    const newIntent = this.detectIntent(newInput);
    
    if (originalIntent !== newIntent) {
      return 0.8;
    }
    
    return 0.5;
  }

  /**
   * Detect intent from input
   * @param {string} input - Input text
   * @returns {string} - Detected intent
   */
  detectIntent(input) {
    const lowerInput = input.toLowerCase();
    
    if (this.commonPatterns.questions.some(pattern => lowerInput.includes(pattern))) {
      return 'question';
    }
    
    if (this.commonPatterns.requests.some(pattern => lowerInput.includes(pattern))) {
      return 'request';
    }
    
    if (this.commonPatterns.commands.some(pattern => lowerInput.includes(pattern))) {
      return 'command';
    }
    
    return 'unknown';
  }

  /**
   * Determine correction strategy
   * @param {string} partialInput - Partial input
   * @param {string} finalInput - Final input
   * @param {number} similarity - Similarity score
   * @returns {string} - Correction strategy
   */
  determineCorrectionStrategy(partialInput, finalInput, similarity) {
    if (similarity < 0.3) {
      return 'complete_restart'; // Completely different - restart from scratch
    } else if (similarity < 0.7) {
      return 'pivot_response'; // Partially different - try to pivot
    } else {
      return 'minor_adjustment'; // Mostly similar - minor adjustments
    }
  }

  /**
   * Update average speculation time
   * @param {number} speculationTime - Time taken for speculation
   */
  updateAverageSpeculationTime(speculationTime) {
    const count = this.metrics.successfulSpeculations;
    this.metrics.avgSpeculationTime = (
      (this.metrics.avgSpeculationTime * (count - 1)) + speculationTime
    ) / count;
  }

  /**
   * Reset speculation state
   */
  resetSpeculation() {
    this.currentSpeculation = {
      state: SPECULATION_STATES.IDLE,
      partialInput: '',
      finalInput: '',
      confidence: 0,
      startTime: null,
      streamId: null,
      abortController: null,
      generatedTokens: [],
      pivotGeneration: null
    };
  }

  /**
   * Get current speculation state
   * @returns {object} - Current state
   */
  getCurrentState() {
    return {
      ...this.currentSpeculation,
      metrics: this.metrics
    };
  }

  /**
   * Get metrics
   * @returns {object} - Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalSpeculations > 0 ? 
        this.metrics.successfulSpeculations / this.metrics.totalSpeculations : 0,
      currentState: this.currentSpeculation.state
    };
  }

  /**
   * Clean up resources
   */
  cleanup() {
    // Abort any ongoing speculation
    if (this.currentSpeculation.abortController) {
      this.currentSpeculation.abortController.abort();
    }
    
    // Clear caches
    this.intentCache.clear();
    
    // Reset state
    this.resetSpeculation();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

/**
 * Create speculative engine
 * @param {object} options - Options
 * @returns {SpeculativeEngine}
 */
const createSpeculativeEngine = (options = {}) => {
  return new SpeculativeEngine(options);
};

module.exports = {
  createSpeculativeEngine,
  SpeculativeEngine,
  SPECULATION_STATES
};