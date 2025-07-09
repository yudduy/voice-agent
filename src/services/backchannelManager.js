/**
 * Backchannel Manager
 * Handles conversational fillers and backchannels during processing delays
 */
const logger = require('../utils/logger');
const textToSpeech = require('./textToSpeech');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

/**
 * Backchannel types based on context
 */
const BACKCHANNEL_TYPES = {
  ACKNOWLEDGMENT: 'acknowledgment',    // "Got it", "I see", "Okay"
  PROCESSING: 'processing',            // "One moment", "Let me check", "Just a second"
  THINKING: 'thinking',                // "Hmm", "Let me think", "Interesting"
  CONFIRMATION: 'confirmation',        // "Right", "Exactly", "Yes"
  TRANSITION: 'transition',           // "So", "Now", "Well"
  EMPATHY: 'empathy'                  // "I understand", "That makes sense"
};

/**
 * Backchannel timing strategies
 */
const TIMING_STRATEGIES = {
  IMMEDIATE: 'immediate',         // 0-200ms - instant acknowledgment
  SHORT_DELAY: 'short_delay',     // 200-500ms - brief processing
  MEDIUM_DELAY: 'medium_delay',   // 500-1000ms - thinking time
  LONG_DELAY: 'long_delay',       // 1000ms+ - complex processing
  EMERGENCY: 'emergency'          // 1500ms+ - prevent dead air
};

/**
 * Backchannel Manager
 * Manages conversational fillers and timing
 */
class BackchannelManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.config = {
      enabled: options.enabled !== false,
      maxBackchannelDuration: options.maxBackchannelDuration || 2000,
      minDelayForBackchannel: options.minDelayForBackchannel || 300,
      emergencyThreshold: options.emergencyThreshold || 1500,
      conflictAvoidanceMargin: options.conflictAvoidanceMargin || 100,
      ...options
    };
    
    // Backchannel library
    this.backchannelLibrary = new Map();
    
    // Active backchannel tracking
    this.activeBackchannels = new Map();
    this.scheduledBackchannels = new Map();
    
    // Processing state tracking
    this.processingState = {
      isProcessing: false,
      startTime: null,
      expectedDuration: null,
      processingType: null,
      context: null
    };
    
    // Metrics
    this.metrics = {
      totalBackchannels: 0,
      backchannelsByType: new Map(),
      averageDelay: 0,
      conflictsAvoided: 0,
      emergencyActivations: 0
    };
    
    // Initialize library
    this.initializeBackchannelLibrary();
  }

  /**
   * Initialize the backchannel library with pre-generated audio
   */
  async initializeBackchannelLibrary() {
    logger.info('[BackchannelManager] Initializing backchannel library');
    
    // Define backchannel phrases by type
    const backchannelPhrases = {
      [BACKCHANNEL_TYPES.ACKNOWLEDGMENT]: [
        { text: 'Got it', priority: 1, duration: 800 },
        { text: 'I see', priority: 2, duration: 600 },
        { text: 'Okay', priority: 3, duration: 500 },
        { text: 'Right', priority: 4, duration: 400 },
        { text: 'Mm-hmm', priority: 5, duration: 500 }
      ],
      [BACKCHANNEL_TYPES.PROCESSING]: [
        { text: 'One moment', priority: 1, duration: 1200 },
        { text: 'Let me check', priority: 2, duration: 1000 },
        { text: 'Just a second', priority: 3, duration: 1100 },
        { text: 'Give me a moment', priority: 4, duration: 1300 },
        { text: 'Hold on', priority: 5, duration: 700 }
      ],
      [BACKCHANNEL_TYPES.THINKING]: [
        { text: 'Hmm', priority: 1, duration: 600 },
        { text: 'Let me think', priority: 2, duration: 1000 },
        { text: 'Interesting', priority: 3, duration: 900 },
        { text: 'I see what you mean', priority: 4, duration: 1200 },
        { text: 'That\'s a good question', priority: 5, duration: 1400 }
      ],
      [BACKCHANNEL_TYPES.CONFIRMATION]: [
        { text: 'Right', priority: 1, duration: 400 },
        { text: 'Exactly', priority: 2, duration: 600 },
        { text: 'Yes', priority: 3, duration: 300 },
        { text: 'Absolutely', priority: 4, duration: 800 },
        { text: 'That\'s correct', priority: 5, duration: 1000 }
      ],
      [BACKCHANNEL_TYPES.TRANSITION]: [
        { text: 'So', priority: 1, duration: 300 },
        { text: 'Now', priority: 2, duration: 300 },
        { text: 'Well', priority: 3, duration: 400 },
        { text: 'Alright', priority: 4, duration: 500 },
        { text: 'Let me see', priority: 5, duration: 800 }
      ],
      [BACKCHANNEL_TYPES.EMPATHY]: [
        { text: 'I understand', priority: 1, duration: 1000 },
        { text: 'That makes sense', priority: 2, duration: 1200 },
        { text: 'I can see why', priority: 3, duration: 1000 },
        { text: 'Of course', priority: 4, duration: 600 },
        { text: 'I hear you', priority: 5, duration: 800 }
      ]
    };
    
    // Generate audio for each backchannel phrase
    for (const [type, phrases] of Object.entries(backchannelPhrases)) {
      this.backchannelLibrary.set(type, new Map());
      
      for (const phrase of phrases) {
        try {
          // Generate audio with ElevenLabs using a more conversational tone
          const audioUrl = await textToSpeech.generateElevenLabsAudio(phrase.text, {
            voice_settings: {
              stability: 0.8,
              similarity_boost: 0.7,
              style: 0.2, // Slightly more conversational
              use_speaker_boost: true
            },
            model_id: 'eleven_flash_v2_5' // Use fast model for backchannels
          });
          
          if (audioUrl) {
            this.backchannelLibrary.get(type).set(phrase.text, {
              ...phrase,
              audioUrl,
              generated: true
            });
            
            logger.debug('[BackchannelManager] Generated audio for backchannel', {
              type,
              text: phrase.text,
              audioUrl
            });
          }
        } catch (error) {
          logger.error('[BackchannelManager] Failed to generate backchannel audio', {
            type,
            text: phrase.text,
            error: error.message
          });
          
          // Store without audio - will use TTS fallback
          this.backchannelLibrary.get(type).set(phrase.text, {
            ...phrase,
            audioUrl: null,
            generated: false
          });
        }
      }
    }
    
    logger.info('[BackchannelManager] Backchannel library initialized', {
      totalTypes: this.backchannelLibrary.size,
      totalPhrases: Array.from(this.backchannelLibrary.values()).reduce((sum, map) => sum + map.size, 0)
    });
  }

  /**
   * Start processing and potentially schedule backchannel
   * @param {object} context - Processing context
   * @returns {Promise<object>} - Backchannel decision
   */
  async startProcessing(context = {}) {
    const {
      processingType = 'general',
      userInput = '',
      expectedDuration = null,
      conversationContext = {},
      priority = 'normal'
    } = context;
    
    logger.debug('[BackchannelManager] Processing started', {
      processingType,
      userInput: userInput.substring(0, 30) + '...',
      expectedDuration,
      priority
    });
    
    // Update processing state
    this.processingState = {
      isProcessing: true,
      startTime: Date.now(),
      expectedDuration,
      processingType,
      context: conversationContext
    };
    
    // Determine if backchannel should be scheduled
    const backchannelDecision = await this.analyzeBackchannelNeed(context);
    
    if (backchannelDecision.shouldSchedule) {
      return await this.scheduleBackchannel(backchannelDecision);
    }
    
    return backchannelDecision;
  }

  /**
   * Analyze if backchannel is needed
   * @param {object} context - Processing context
   * @returns {Promise<object>} - Backchannel analysis
   */
  async analyzeBackchannelNeed(context) {
    const {
      processingType,
      userInput,
      expectedDuration,
      conversationContext,
      priority
    } = context;
    
    // Don't schedule if disabled
    if (!this.config.enabled) {
      return { shouldSchedule: false, reason: 'Disabled' };
    }
    
    // Don't schedule for very short processing
    if (expectedDuration && expectedDuration < this.config.minDelayForBackchannel) {
      return { shouldSchedule: false, reason: 'Too short' };
    }
    
    // Analyze user input for backchannel type
    const backchannelType = this.determineBackchannelType(userInput, conversationContext);
    
    // Determine timing strategy
    const timingStrategy = this.determineTimingStrategy(expectedDuration, priority);
    
    // Calculate delay
    const delay = this.calculateBackchannelDelay(timingStrategy, expectedDuration);
    
    return {
      shouldSchedule: true,
      backchannelType,
      timingStrategy,
      delay,
      priority,
      processingType
    };
  }

  /**
   * Schedule a backchannel
   * @param {object} decision - Backchannel decision
   * @returns {Promise<object>} - Scheduling result
   */
  async scheduleBackchannel(decision) {
    const {
      backchannelType,
      timingStrategy,
      delay,
      priority,
      processingType
    } = decision;
    
    const scheduleId = `backchannel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    logger.debug('[BackchannelManager] Scheduling backchannel', {
      scheduleId,
      backchannelType,
      timingStrategy,
      delay,
      priority
    });
    
    // Select appropriate backchannel phrase
    const selectedBackchannel = this.selectBackchannel(backchannelType, {
      priority,
      processingType,
      context: this.processingState.context
    });
    
    if (!selectedBackchannel) {
      logger.warn('[BackchannelManager] No suitable backchannel found', {
        backchannelType,
        priority
      });
      return { scheduled: false, reason: 'No suitable backchannel' };
    }
    
    // Schedule the backchannel
    const timeoutId = setTimeout(async () => {
      await this.executeBackchannel(scheduleId, selectedBackchannel);
    }, delay);
    
    // Store scheduled backchannel
    this.scheduledBackchannels.set(scheduleId, {
      id: scheduleId,
      backchannelType,
      selectedBackchannel,
      timingStrategy,
      delay,
      scheduledAt: Date.now(),
      timeoutId,
      status: 'scheduled'
    });
    
    return {
      scheduled: true,
      scheduleId,
      backchannelType,
      selectedBackchannel,
      delay,
      timingStrategy
    };
  }

  /**
   * Execute a scheduled backchannel
   * @param {string} scheduleId - Schedule ID
   * @param {object} backchannel - Backchannel to execute
   */
  async executeBackchannel(scheduleId, backchannel) {
    const scheduled = this.scheduledBackchannels.get(scheduleId);
    if (!scheduled) {
      logger.warn('[BackchannelManager] Scheduled backchannel not found', { scheduleId });
      return;
    }
    
    // Check if processing is still active
    if (!this.processingState.isProcessing) {
      logger.debug('[BackchannelManager] Processing finished, cancelling backchannel', { scheduleId });
      this.scheduledBackchannels.delete(scheduleId);
      return;
    }
    
    // Check for conflicts with active responses
    if (this.hasActiveResponseConflict()) {
      logger.debug('[BackchannelManager] Conflict detected, cancelling backchannel', { scheduleId });
      this.metrics.conflictsAvoided++;
      this.scheduledBackchannels.delete(scheduleId);
      return;
    }
    
    logger.info('[BackchannelManager] Executing backchannel', {
      scheduleId,
      text: backchannel.text,
      type: scheduled.backchannelType
    });
    
    // Update scheduled backchannel status
    scheduled.status = 'executing';
    scheduled.executedAt = Date.now();
    
    // Move to active backchannels
    this.activeBackchannels.set(scheduleId, scheduled);
    this.scheduledBackchannels.delete(scheduleId);
    
    // Execute the backchannel
    try {
      await this.playBackchannel(backchannel);
      
      // Update metrics
      this.metrics.totalBackchannels++;
      const typeCount = this.metrics.backchannelsByType.get(scheduled.backchannelType) || 0;
      this.metrics.backchannelsByType.set(scheduled.backchannelType, typeCount + 1);
      
      // Emit backchannel executed event
      this.emit('backchannelExecuted', {
        scheduleId,
        backchannel,
        type: scheduled.backchannelType,
        delay: scheduled.delay,
        actualDelay: scheduled.executedAt - scheduled.scheduledAt
      });
      
      // Mark as completed
      scheduled.status = 'completed';
      scheduled.completedAt = Date.now();
      
    } catch (error) {
      logger.error('[BackchannelManager] Failed to execute backchannel', {
        scheduleId,
        error: error.message
      });
      
      scheduled.status = 'failed';
      scheduled.error = error.message;
      
      this.emit('backchannelFailed', {
        scheduleId,
        backchannel,
        error: error.message
      });
    }
  }

  /**
   * Play a backchannel
   * @param {object} backchannel - Backchannel to play
   */
  async playBackchannel(backchannel) {
    if (backchannel.audioUrl && backchannel.generated) {
      // Use pre-generated audio
      this.emit('audioReady', {
        audioUrl: backchannel.audioUrl,
        text: backchannel.text,
        duration: backchannel.duration,
        isBackchannel: true
      });
    } else {
      // Generate audio on-the-fly
      const audioUrl = await textToSpeech.generateElevenLabsAudio(backchannel.text, {
        voice_settings: {
          stability: 0.8,
          similarity_boost: 0.7,
          style: 0.2,
          use_speaker_boost: true
        },
        model_id: 'eleven_flash_v2_5'
      });
      
      if (audioUrl) {
        this.emit('audioReady', {
          audioUrl,
          text: backchannel.text,
          duration: backchannel.duration,
          isBackchannel: true
        });
      } else {
        // Fallback to TTS
        this.emit('audioReady', {
          audioUrl: 'twilio:' + backchannel.text,
          text: backchannel.text,
          duration: backchannel.duration,
          isBackchannel: true
        });
      }
    }
  }

  /**
   * End processing and cancel any scheduled backchannels
   */
  endProcessing() {
    logger.debug('[BackchannelManager] Processing ended');
    
    // Update processing state
    this.processingState.isProcessing = false;
    
    // Cancel all scheduled backchannels
    for (const [scheduleId, scheduled] of this.scheduledBackchannels.entries()) {
      if (scheduled.timeoutId) {
        clearTimeout(scheduled.timeoutId);
      }
      logger.debug('[BackchannelManager] Cancelled scheduled backchannel', { scheduleId });
    }
    
    this.scheduledBackchannels.clear();
    
    // Clean up completed active backchannels
    setTimeout(() => {
      this.cleanupActiveBackchannels();
    }, 5000);
  }

  /**
   * Determine backchannel type based on user input
   * @param {string} userInput - User input
   * @param {object} conversationContext - Conversation context
   * @returns {string} - Backchannel type
   */
  determineBackchannelType(userInput, conversationContext = {}) {
    const lowerInput = userInput.toLowerCase();
    
    // Check for question indicators
    if (lowerInput.includes('?') || lowerInput.startsWith('what') || 
        lowerInput.startsWith('how') || lowerInput.startsWith('when') ||
        lowerInput.startsWith('where') || lowerInput.startsWith('why')) {
      return BACKCHANNEL_TYPES.THINKING;
    }
    
    // Check for complex requests
    if (lowerInput.includes('schedule') || lowerInput.includes('create') ||
        lowerInput.includes('find') || lowerInput.includes('search')) {
      return BACKCHANNEL_TYPES.PROCESSING;
    }
    
    // Check for emotional content
    if (lowerInput.includes('problem') || lowerInput.includes('issue') ||
        lowerInput.includes('difficult') || lowerInput.includes('frustrated')) {
      return BACKCHANNEL_TYPES.EMPATHY;
    }
    
    // Check for confirmations
    if (lowerInput.includes('yes') || lowerInput.includes('correct') ||
        lowerInput.includes('right') || lowerInput.includes('exactly')) {
      return BACKCHANNEL_TYPES.CONFIRMATION;
    }
    
    // Default to acknowledgment
    return BACKCHANNEL_TYPES.ACKNOWLEDGMENT;
  }

  /**
   * Determine timing strategy based on expected duration
   * @param {number} expectedDuration - Expected processing duration
   * @param {string} priority - Processing priority
   * @returns {string} - Timing strategy
   */
  determineTimingStrategy(expectedDuration, priority) {
    if (expectedDuration) {
      if (expectedDuration < 500) {
        return TIMING_STRATEGIES.IMMEDIATE;
      } else if (expectedDuration < 1000) {
        return TIMING_STRATEGIES.SHORT_DELAY;
      } else if (expectedDuration < 1500) {
        return TIMING_STRATEGIES.MEDIUM_DELAY;
      } else {
        return TIMING_STRATEGIES.LONG_DELAY;
      }
    }
    
    // Default based on priority
    if (priority === 'high') {
      return TIMING_STRATEGIES.SHORT_DELAY;
    } else if (priority === 'low') {
      return TIMING_STRATEGIES.MEDIUM_DELAY;
    }
    
    return TIMING_STRATEGIES.SHORT_DELAY;
  }

  /**
   * Calculate backchannel delay
   * @param {string} timingStrategy - Timing strategy
   * @param {number} expectedDuration - Expected duration
   * @returns {number} - Delay in milliseconds
   */
  calculateBackchannelDelay(timingStrategy, expectedDuration) {
    switch (timingStrategy) {
      case TIMING_STRATEGIES.IMMEDIATE:
        return 100;
      case TIMING_STRATEGIES.SHORT_DELAY:
        return 300;
      case TIMING_STRATEGIES.MEDIUM_DELAY:
        return 600;
      case TIMING_STRATEGIES.LONG_DELAY:
        return 1000;
      case TIMING_STRATEGIES.EMERGENCY:
        return this.config.emergencyThreshold;
      default:
        return 400;
    }
  }

  /**
   * Select appropriate backchannel
   * @param {string} type - Backchannel type
   * @param {object} options - Selection options
   * @returns {object|null} - Selected backchannel
   */
  selectBackchannel(type, options = {}) {
    const typeLibrary = this.backchannelLibrary.get(type);
    if (!typeLibrary || typeLibrary.size === 0) {
      return null;
    }
    
    // Convert to array and sort by priority
    const backchannels = Array.from(typeLibrary.values()).sort((a, b) => a.priority - b.priority);
    
    // Select based on priority and availability
    for (const backchannel of backchannels) {
      if (this.isBackchannelAvailable(backchannel)) {
        return backchannel;
      }
    }
    
    // Fallback to first available
    return backchannels[0] || null;
  }

  /**
   * Check if backchannel is available
   * @param {object} backchannel - Backchannel to check
   * @returns {boolean} - Is available
   */
  isBackchannelAvailable(backchannel) {
    // Check if recently used
    const recentUsage = Array.from(this.activeBackchannels.values())
      .filter(active => active.selectedBackchannel.text === backchannel.text)
      .filter(active => Date.now() - active.executedAt < 5000); // 5 seconds
    
    return recentUsage.length === 0;
  }

  /**
   * Check for active response conflicts
   * @returns {boolean} - Has conflict
   */
  hasActiveResponseConflict() {
    // This would integrate with the main response system
    // For now, return false - in production, check if AI is about to respond
    return false;
  }

  /**
   * Clean up completed active backchannels
   */
  cleanupActiveBackchannels() {
    const now = Date.now();
    const maxAge = 30000; // 30 seconds
    
    for (const [scheduleId, active] of this.activeBackchannels.entries()) {
      if (active.completedAt && now - active.completedAt > maxAge) {
        this.activeBackchannels.delete(scheduleId);
      }
    }
  }

  /**
   * Handle emergency silence (prevent dead air)
   */
  handleEmergencySilence() {
    if (this.processingState.isProcessing) {
      const processingTime = Date.now() - this.processingState.startTime;
      
      if (processingTime > this.config.emergencyThreshold) {
        logger.warn('[BackchannelManager] Emergency silence detected', {
          processingTime,
          threshold: this.config.emergencyThreshold
        });
        
        // Schedule emergency backchannel
        this.scheduleBackchannel({
          backchannelType: BACKCHANNEL_TYPES.PROCESSING,
          timingStrategy: TIMING_STRATEGIES.EMERGENCY,
          delay: 0,
          priority: 'emergency',
          processingType: 'emergency'
        });
        
        this.metrics.emergencyActivations++;
      }
    }
  }

  /**
   * Get current metrics
   * @returns {object} - Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeBackchannels: this.activeBackchannels.size,
      scheduledBackchannels: this.scheduledBackchannels.size,
      isProcessing: this.processingState.isProcessing,
      processingTime: this.processingState.isProcessing ? 
        Date.now() - this.processingState.startTime : 0
    };
  }

  /**
   * Get current state
   * @returns {object} - Current state
   */
  getCurrentState() {
    return {
      processingState: this.processingState,
      activeBackchannels: Array.from(this.activeBackchannels.values()),
      scheduledBackchannels: Array.from(this.scheduledBackchannels.values()),
      metrics: this.getMetrics()
    };
  }

  /**
   * Clean up resources
   */
  cleanup() {
    logger.info('[BackchannelManager] Cleaning up resources');
    
    // Cancel all scheduled backchannels
    for (const [scheduleId, scheduled] of this.scheduledBackchannels.entries()) {
      if (scheduled.timeoutId) {
        clearTimeout(scheduled.timeoutId);
      }
    }
    
    // Clear all maps
    this.scheduledBackchannels.clear();
    this.activeBackchannels.clear();
    
    // Reset processing state
    this.processingState.isProcessing = false;
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

/**
 * Create backchannel manager
 * @param {object} options - Options
 * @returns {BackchannelManager}
 */
const createBackchannelManager = (options = {}) => {
  return new BackchannelManager(options);
};

module.exports = {
  createBackchannelManager,
  BackchannelManager,
  BACKCHANNEL_TYPES,
  TIMING_STRATEGIES
};