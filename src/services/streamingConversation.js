/**
 * Streaming conversation service with OpenAI streaming API
 * Optimized for low-latency voice interactions with speculative execution
 */
const logger = require('../utils/logger');
const aiConfig = require('../config/ai');
const OpenAI = require('openai');
const EventEmitter = require('events');
const cacheService = require('./cacheService');
const userRepository = require('../repositories/userRepository');
const promptUtils = require('../utils/prompt');
const topicTracker = require('./topicTracker');
const { createSpeculativeEngine, SPECULATION_STATES } = require('./speculativeEngine');
const { createBackchannelManager } = require('./backchannelManager');

const openai = new OpenAI({
  apiKey: aiConfig.openAI.apiKey,
});

/**
 * Detects sentence boundaries for chunking
 * @param {string} text - Text to check
 * @returns {Array<{sentence: string, isComplete: boolean}>}
 */
const detectSentences = (text) => {
  const sentences = [];
  const sentenceRegex = /([.!?]+\s*)/g;
  let lastIndex = 0;
  let match;

  while ((match = sentenceRegex.exec(text)) !== null) {
    const sentence = text.substring(lastIndex, match.index + match[0].length);
    sentences.push({ sentence: sentence.trim(), isComplete: true });
    lastIndex = match.index + match[0].length;
  }

  // Handle remaining text that doesn't end with punctuation
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex).trim();
    if (remaining) {
      // Check if it's likely a complete thought (heuristic based on length and last word)
      const isLikelyComplete = remaining.length > 50 || remaining.split(' ').length > 8;
      sentences.push({ sentence: remaining, isComplete: isLikelyComplete });
    }
  }

  return sentences;
};

/**
 * StreamingConversationHandler - Manages streaming AI responses with speculative execution
 */
class StreamingConversationHandler extends EventEmitter {
  constructor(userId, callSid) {
    super();
    this.userId = userId;
    this.callSid = callSid;
    this.buffer = '';
    this.sentenceQueue = [];
    this.isFirstChunk = true;
    this.startTime = Date.now();
    
    // Enhanced components
    this.speculativeEngine = createSpeculativeEngine({
      minSpeculationLength: 12,
      correctionThreshold: 0.25,
      confidenceThreshold: 0.65
    });
    
    this.backchannelManager = createBackchannelManager({
      enabled: process.env.ENABLE_BACKCHANNELS === 'true',
      minDelayForBackchannel: 250,
      emergencyThreshold: 1200
    });
    
    // Speculation state
    this.speculationState = {
      isActive: false,
      currentStream: null,
      abortController: null,
      partialInput: '',
      speculativeResponse: '',
      needsCorrection: false
    };
    
    // Metrics
    this.metrics = {
      firstChunkMs: null,
      totalChunks: 0,
      sentences: [],
      speculativeExecutions: 0,
      successfulSpeculations: 0,
      corrections: 0,
      backchannelsTriggered: 0
    };
    
    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for speculative engine and backchannel manager
   */
  setupEventHandlers() {
    // Speculative engine events
    this.speculativeEngine.on('speculationStarted', (data) => {
      logger.debug('[StreamingConversation] Speculation started', {
        callSid: this.callSid,
        partialInput: data.partialInput.substring(0, 30) + '...'
      });
      this.metrics.speculativeExecutions++;
    });
    
    this.speculativeEngine.on('speculationConfirmed', (data) => {
      logger.info('[StreamingConversation] Speculation confirmed', {
        callSid: this.callSid,
        similarity: data.similarity,
        speculationTime: data.speculationTime
      });
      this.metrics.successfulSpeculations++;
    });
    
    this.speculativeEngine.on('speculationCorrected', (data) => {
      logger.warn('[StreamingConversation] Speculation corrected', {
        callSid: this.callSid,
        correctionStrategy: data.correctionStrategy,
        similarity: data.similarity
      });
      this.metrics.corrections++;
      this.speculationState.needsCorrection = true;
    });
    
    // Backchannel manager events
    this.backchannelManager.on('backchannelExecuted', (data) => {
      logger.debug('[StreamingConversation] Backchannel executed', {
        callSid: this.callSid,
        type: data.type,
        text: data.backchannel.text
      });
      this.metrics.backchannelsTriggered++;
      
      // Emit backchannel event
      this.emit('backchannel', {
        audioUrl: data.backchannel.audioUrl,
        text: data.backchannel.text,
        type: data.type,
        isBackchannel: true
      });
    });
    
    this.backchannelManager.on('audioReady', (data) => {
      // Forward backchannel audio to main pipeline
      this.emit('sentence', {
        text: data.text,
        audioUrl: data.audioUrl,
        index: -1, // Special index for backchannels
        isBackchannel: true,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Process partial STT input for speculative execution
   * @param {string} partialInput - Partial transcription
   * @param {number} confidence - STT confidence score
   * @returns {Promise<object>} - Speculation result
   */
  async processPartialInput(partialInput, confidence = 1.0) {
    try {
      logger.debug('[StreamingConversation] Processing partial input', {
        callSid: this.callSid,
        partialInput: partialInput.substring(0, 30) + '...',
        confidence,
        speculationActive: this.speculationState.isActive
      });
      
      // Process with speculative engine
      const speculationResult = await this.speculativeEngine.processPartialInput(
        partialInput,
        confidence,
        false
      );
      
      if (speculationResult.shouldSpeculate && !this.speculationState.isActive) {
        // Start speculative execution
        await this.startSpeculativeExecution(partialInput, speculationResult);
      } else if (this.speculationState.isActive) {
        // Update existing speculation
        await this.updateSpeculativeExecution(partialInput, speculationResult);
      }
      
      return speculationResult;
      
    } catch (error) {
      logger.error('[StreamingConversation] Error processing partial input', {
        callSid: this.callSid,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Start speculative execution
   * @param {string} partialInput - Partial input
   * @param {object} speculationResult - Speculation result
   */
  async startSpeculativeExecution(partialInput, speculationResult) {
    logger.info('[StreamingConversation] Starting speculative execution', {
      callSid: this.callSid,
      partialInput: partialInput.substring(0, 30) + '...'
    });
    
    // Update speculation state
    this.speculationState.isActive = true;
    this.speculationState.partialInput = partialInput;
    this.speculationState.abortController = speculationResult.abortController;
    
    // Start backchannel processing
    await this.backchannelManager.startProcessing({
      processingType: 'speculation',
      userInput: partialInput,
      expectedDuration: 800, // Estimated speculation time
      priority: 'high'
    });
    
    // Start speculative LLM generation
    await this.generateSpeculativeResponse(partialInput, speculationResult);
  }

  /**
   * Update speculative execution
   * @param {string} partialInput - Updated partial input
   * @param {object} speculationResult - Speculation result
   */
  async updateSpeculativeExecution(partialInput, speculationResult) {
    if (speculationResult.pivoted) {
      logger.info('[StreamingConversation] Pivoting speculative execution', {
        callSid: this.callSid,
        newInput: partialInput.substring(0, 30) + '...'
      });
      
      // Abort current speculation
      if (this.speculationState.abortController) {
        this.speculationState.abortController.abort();
      }
      
      // Update state
      this.speculationState.partialInput = partialInput;
      this.speculationState.abortController = speculationResult.abortController;
      
      // Start new speculation
      await this.generateSpeculativeResponse(partialInput, speculationResult);
    }
  }

  /**
   * Generate speculative response
   * @param {string} partialInput - Partial input
   * @param {object} speculationResult - Speculation result
   */
  async generateSpeculativeResponse(partialInput, speculationResult) {
    try {
      // Get conversation context
      const conversationHistory = await cacheService.getConversation(this.userId);
      const userTurn = { role: 'user', content: partialInput };
      const speculativeHistory = [...conversationHistory, userTurn];
      
      // Get user profile
      const user = await userRepository.findUser({ id: this.userId });
      const contact = user || { name: 'there' };
      
      // Generate messages
      const messages = await promptUtils.generatePersonalizedPrompt(
        contact,
        speculativeHistory,
        this.userId
      );
      
      logger.debug('[StreamingConversation] Starting speculative OpenAI stream', {
        callSid: this.callSid,
        streamId: speculationResult.streamId,
        predictedCompletion: speculationResult.predictedCompletion
      });
      
      // Create streaming completion with abort signal
      const stream = await openai.chat.completions.create({
        model: aiConfig.openAI.streamingModel || 'gpt-4o-mini',
        messages: messages,
        temperature: aiConfig.openAI.temperature,
        max_tokens: aiConfig.openAI.streamingMaxTokens || 120,
        stream: true,
      }, {
        signal: speculationResult.abortController.signal
      });
      
      // Store stream reference
      this.speculationState.currentStream = stream;
      
      // Process speculative stream
      await this.processSpeculativeStream(stream, speculationResult.streamId);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.debug('[StreamingConversation] Speculative stream aborted', {
          callSid: this.callSid
        });
      } else {
        logger.error('[StreamingConversation] Speculative generation failed', {
          callSid: this.callSid,
          error: error.message
        });
      }
    }
  }

  /**
   * Process speculative stream
   * @param {object} stream - OpenAI stream
   * @param {string} streamId - Stream ID
   */
  async processSpeculativeStream(stream, streamId) {
    let speculativeResponse = '';
    
    try {
      for await (const chunk of stream) {
        // Check if stream was aborted
        if (this.speculationState.abortController?.signal.aborted) {
          logger.debug('[StreamingConversation] Speculative stream aborted during processing', {
            callSid: this.callSid,
            streamId
          });
          break;
        }
        
        const content = chunk.choices[0]?.delta?.content || '';
        
        if (content) {
          speculativeResponse += content;
          this.buffer += content;
          
          // Track first chunk timing
          if (this.isFirstChunk) {
            this.metrics.firstChunkMs = Date.now() - this.startTime;
            this.isFirstChunk = false;
          }
          
          // Check for complete sentences
          const sentences = detectSentences(this.buffer);
          
          for (const { sentence, isComplete } of sentences) {
            if (isComplete) {
              // Emit speculative sentence
              this.emit('speculativeSentence', {
                text: sentence,
                index: this.sentenceQueue.length,
                isFirst: this.sentenceQueue.length === 0,
                streamId,
                timestamp: Date.now()
              });
              
              this.sentenceQueue.push(sentence);
              this.buffer = this.buffer.replace(sentence, '').trim();
            }
          }
        }
        
        // Check for end of stream
        if (chunk.choices[0]?.finish_reason) {
          // Process remaining buffer
          if (this.buffer.trim()) {
            this.emit('speculativeSentence', {
              text: this.buffer.trim(),
              index: this.sentenceQueue.length,
              isFirst: this.sentenceQueue.length === 0,
              isLast: true,
              streamId,
              timestamp: Date.now()
            });
            this.sentenceQueue.push(this.buffer.trim());
          }
          
          break;
        }
      }
      
      // Store speculative response
      this.speculationState.speculativeResponse = speculativeResponse;
      
      logger.debug('[StreamingConversation] Speculative stream completed', {
        callSid: this.callSid,
        streamId,
        responseLength: speculativeResponse.length
      });
      
    } catch (error) {
      if (error.name !== 'AbortError') {
        logger.error('[StreamingConversation] Error processing speculative stream', {
          callSid: this.callSid,
          streamId,
          error: error.message
        });
      }
    }
  }

  /**
   * Process complete STT input (final transcription)
   * @param {string} finalInput - Final transcription
   * @param {number} confidence - STT confidence score
   * @returns {Promise<object>} - Processing result
   */
  async processCompleteInput(finalInput, confidence = 1.0) {
    try {
      logger.info('[StreamingConversation] Processing complete input', {
        callSid: this.callSid,
        finalInput: finalInput.substring(0, 30) + '...',
        confidence,
        speculationActive: this.speculationState.isActive
      });
      
      // End backchannel processing
      this.backchannelManager.endProcessing();
      
      if (this.speculationState.isActive) {
        // Validate speculation
        const validationResult = await this.speculativeEngine.processPartialInput(
          finalInput,
          confidence,
          true
        );
        
        if (validationResult.requiresCorrection) {
          // Speculation was wrong - need to correct
          return await this.handleSpeculationCorrection(finalInput, validationResult);
        } else {
          // Speculation was correct - confirm it
          return await this.confirmSpeculation(finalInput, validationResult);
        }
      } else {
        // No speculation - process normally
        return await this.processStreamingResponse(finalInput);
      }
      
    } catch (error) {
      logger.error('[StreamingConversation] Error processing complete input', {
        callSid: this.callSid,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Handle speculation correction
   * @param {string} finalInput - Final input
   * @param {object} validationResult - Validation result
   * @returns {Promise<object>} - Correction result
   */
  async handleSpeculationCorrection(finalInput, validationResult) {
    logger.warn('[StreamingConversation] Handling speculation correction', {
      callSid: this.callSid,
      correctionStrategy: validationResult.correctionStrategy,
      similarity: validationResult.similarity
    });
    
    // Abort current speculation
    if (this.speculationState.abortController) {
      this.speculationState.abortController.abort();
    }
    
    // Reset state
    this.resetSpeculationState();
    
    // Process with correct input
    const result = await this.processStreamingResponse(finalInput);
    
    // Add correction metadata
    result.corrected = true;
    result.correctionStrategy = validationResult.correctionStrategy;
    result.similarity = validationResult.similarity;
    
    return result;
  }

  /**
   * Confirm speculation
   * @param {string} finalInput - Final input
   * @param {object} validationResult - Validation result
   * @returns {Promise<object>} - Confirmation result
   */
  async confirmSpeculation(finalInput, validationResult) {
    logger.info('[StreamingConversation] Confirming speculation', {
      callSid: this.callSid,
      similarity: validationResult.similarity,
      speculationTime: validationResult.speculationTime
    });
    
    // Update conversation history with final input
    const conversationHistory = await cacheService.getConversation(this.userId);
    const userTurn = { role: 'user', content: finalInput };
    const assistantTurn = { role: 'assistant', content: this.speculationState.speculativeResponse };
    
    conversationHistory.push(userTurn);
    conversationHistory.push(assistantTurn);
    
    await cacheService.updateConversation(this.userId, conversationHistory);
    
    // Topic tracking
    await topicTracker.trackTopics(this.userId, finalInput, this.speculationState.speculativeResponse);
    
    // Check for hangup
    const shouldHangup = this.checkForHangup(this.speculationState.speculativeResponse);
    
    // Reset speculation state
    this.resetSpeculationState();
    
    return {
      fullResponse: this.speculationState.speculativeResponse,
      shouldHangup,
      speculative: true,
      similarity: validationResult.similarity,
      speculationTime: validationResult.speculationTime
    };
  }

  /**
   * Reset speculation state
   */
  resetSpeculationState() {
    this.speculationState.isActive = false;
    this.speculationState.currentStream = null;
    this.speculationState.abortController = null;
    this.speculationState.partialInput = '';
    this.speculationState.speculativeResponse = '';
    this.speculationState.needsCorrection = false;
  }

  /**
   * Process streaming response from OpenAI (original method, now enhanced)
   * @param {string} userInput - User's transcribed speech
   * @returns {Promise<object>} - Processing result
   */
  async processStreamingResponse(userInput) {
    try {
      // Get conversation context
      const conversationHistory = await cacheService.getConversation(this.userId);
      const userTurn = { role: 'user', content: userInput };
      conversationHistory.push(userTurn);

      // Get user profile for personalization
      const user = await userRepository.findUser({ id: this.userId });
      const contact = user || { name: 'there' };

      // Generate messages with optimized prompt
      const messages = await promptUtils.generatePersonalizedPrompt(contact, conversationHistory, this.userId);

      logger.debug('[StreamingConversation] Starting OpenAI stream', {
        callSid: this.callSid,
        userId: this.userId,
        model: aiConfig.openAI.streamingModel || 'gpt-4o-mini',
        userInputLength: userInput.length
      });

      // Create streaming completion
      const stream = await openai.chat.completions.create({
        model: aiConfig.openAI.streamingModel || 'gpt-4o-mini',
        messages: messages,
        temperature: aiConfig.openAI.temperature,
        max_tokens: aiConfig.openAI.streamingMaxTokens || 120,
        stream: true,
      });

      let fullResponse = '';

      // Process stream chunks
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        
        if (content) {
          this.metrics.totalChunks++;
          
          // Track first chunk timing
          if (this.isFirstChunk) {
            this.metrics.firstChunkMs = Date.now() - this.startTime;
            this.isFirstChunk = false;
            logger.info('[StreamingConversation] First chunk received', {
              callSid: this.callSid,
              firstChunkMs: this.metrics.firstChunkMs
            });
          }

          // Add to buffer and full response
          this.buffer += content;
          fullResponse += content;

          // Check for complete sentences
          const sentences = detectSentences(this.buffer);
          
          for (const { sentence, isComplete } of sentences) {
            if (isComplete) {
              // Emit complete sentence for immediate TTS processing
              this.emit('sentence', {
                text: sentence,
                index: this.sentenceQueue.length,
                isFirst: this.sentenceQueue.length === 0,
                timestamp: Date.now()
              });

              this.sentenceQueue.push(sentence);
              this.metrics.sentences.push({
                text: sentence,
                emittedAt: Date.now() - this.startTime
              });

              // Clear this sentence from buffer
              this.buffer = this.buffer.replace(sentence, '').trim();
            }
          }
        }

        // Check for end of stream
        if (chunk.choices[0]?.finish_reason) {
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.emit('sentence', {
              text: this.buffer.trim(),
              index: this.sentenceQueue.length,
              isFirst: this.sentenceQueue.length === 0,
              isLast: true,
              timestamp: Date.now()
            });
            this.sentenceQueue.push(this.buffer.trim());
          }

          // Emit completion event
          this.emit('complete', {
            fullResponse,
            metrics: this.metrics,
            totalLatency: Date.now() - this.startTime
          });

          break;
        }
      }

      // Update conversation history
      const assistantTurn = { role: 'assistant', content: fullResponse };
      conversationHistory.push(assistantTurn);
      await cacheService.updateConversation(this.userId, conversationHistory);

      // Topic tracking
      await topicTracker.trackTopics(this.userId, userInput, fullResponse);

      // Check for conversation end
      const shouldHangup = this.checkForHangup(fullResponse);

      logger.info('[StreamingConversation] Stream completed', {
        callSid: this.callSid,
        userId: this.userId,
        responseLength: fullResponse.length,
        sentenceCount: this.sentenceQueue.length,
        totalLatency: Date.now() - this.startTime,
        metrics: this.metrics,
        shouldHangup
      });

      return { fullResponse, shouldHangup };

    } catch (error) {
      logger.error('[StreamingConversation] Error in streaming response', {
        callSid: this.callSid,
        userId: this.userId,
        error: error.message,
        stack: error.stack
      });

      // Emit error event
      this.emit('error', error);
      
      throw error;
    }
  }

  /**
   * Check if the response indicates end of conversation
   * @param {string} response - AI response text
   * @returns {boolean}
   */
  checkForHangup(response) {
    const hangupPhrases = [
      'goodbye', 'bye', 'have a great day', 'take care',
      'talk to you later', 'see you', 'farewell',
      'ending the call', 'end this call', 'hanging up'
    ];
    
    const lowerResponse = response.toLowerCase();
    return hangupPhrases.some(phrase => lowerResponse.includes(phrase));
  }

  /**
   * Get enhanced metrics including speculation and backchannel data
   * @returns {object} - Enhanced metrics
   */
  getEnhancedMetrics() {
    return {
      ...this.metrics,
      speculativeEngine: this.speculativeEngine.getMetrics(),
      backchannelManager: this.backchannelManager.getMetrics(),
      speculationState: {
        isActive: this.speculationState.isActive,
        partialInput: this.speculationState.partialInput.substring(0, 30) + '...',
        needsCorrection: this.speculationState.needsCorrection
      }
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    // Cleanup speculation
    if (this.speculationState.abortController) {
      this.speculationState.abortController.abort();
    }
    
    // Cleanup components
    if (this.speculativeEngine) {
      this.speculativeEngine.cleanup();
    }
    
    if (this.backchannelManager) {
      this.backchannelManager.cleanup();
    }
    
    // Reset state
    this.resetSpeculationState();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

/**
 * Factory function to create streaming conversation handler
 * @param {string} userId - User ID
 * @param {string} callSid - Twilio Call SID
 * @returns {StreamingConversationHandler}
 */
const createStreamingHandler = (userId, callSid) => {
  return new StreamingConversationHandler(userId, callSid);
};

module.exports = {
  createStreamingHandler,
  detectSentences,
  StreamingConversationHandler
};