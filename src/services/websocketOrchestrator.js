/**
 * WebSocket Orchestrator for Real-time Voice Pipeline
 * Manages the entire real-time conversation flow.
 */

const WebSocket = require('ws');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');
const conversationService = require('./conversation');
const userRepository = require('../repositories/userRepository');
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const aiConfig = require('../config/ai');
const { createElevenLabsStream } = require('./elevenLabsStream');
const { featureFlags } = require('../config/featureFlags');
const performanceMonitor = require('../utils/performanceMonitor');
const connectionPool = require('./connectionPool');
const ffmpegPool = require('./ffmpegPool');
const audioCache = require('./audioCache');
const textToSpeech = require('./textToSpeech');
const ConversationCycleTracker = require('../utils/conversationCycleTracker');
const sentenceDetector = require('../utils/sentenceCompletionDetector');


class WebSocketOrchestrator extends EventEmitter {
  constructor(callSid, initialUserId) {
    super();
    this.callSid = callSid;
    // The userId is now passed in the 'start' message, so we initialize it as null.
    this.userId = initialUserId;
    
    // Start performance monitoring session
    performanceMonitor.startSession(this.callSid);
    
    // Initialize conversation cycle tracker
    this.cycleTracker = new ConversationCycleTracker(this.callSid);
    this.currentCycleId = null; 
    
    this.twilioWs = null;
    this.deepgramWs = null;
    this.streamSid = null;
    
    // Enhanced state management for proper turn-taking
    this.isSpeaking = false;
    this.isUserSpeaking = false;
    this.lastUserInputTime = 0;
    this.currentResponseId = null;
    this.processingLLM = false;
    this.lastProcessedTranscript = '';
    this.speechEndTimer = null;
    this.ffmpegCommand = null;
    
    // Conversation pattern tracking to prevent loops
    this.conversationPatterns = [];
    this.repetitionCount = 0;
    this.lastQuestionAsked = null;
    this.identificationAttempts = 0;
    
    // Enhanced state tracking
    this.callState = 'IDLE'; // IDLE, LISTENING, LLM_PROCESSING, AGENT_SPEAKING, BARGE_IN_DETECTED
    this.lastAgentUtterance = null;
    this.lastAgentUtteranceStartTime = null;
    this.lastAgentUtteranceEndTime = null;
    this.pendingUserInputs = [];
    this.correlationId = 0; // For tracking related events
    
    // Audio delivery tracking
    this.lastSpokenText = '';
    this.audioDeliveryMetrics = {
      startTime: null,
      chunks: 0,
      bytes: 0,
      completed: false
    };
    
    // Debounce settings
    this.SPEECH_END_TIMEOUT = 700; // ms to wait after speech ends (increased from 500)
    this.MIN_TIME_BETWEEN_RESPONSES = 1200; // ms minimum between LLM calls (increased from 1000)
    this.BARGE_IN_COOLDOWN = 600; // ms to wait after a barge-in before processing new input
    this.BARGE_IN_GRACE_PERIOD_MS = 400; // Grace period to prevent immediate barge-in
    this.speechEndTimer = null;
    this.finalTranscriptTimer = null; // Timer for fallback final transcript processing
    this.ffmpegCommand = null;
    
    // KeepAlive management for Deepgram
    this.keepAliveInterval = null;
    
    // Feature flags
    this.USE_STREAMING_PIPELINE = process.env.ENABLE_SPECULATIVE_TTS === 'true';
    
    logger.debug('WebSocketOrchestrator initialized', {
      callSid: this.callSid,
      timestamp: new Date().toISOString(),
      initialState: this.callState,
      config: {
        speechEndTimeout: this.SPEECH_END_TIMEOUT,
        minTimeBetweenResponses: this.MIN_TIME_BETWEEN_RESPONSES,
        bargeInCooldown: this.BARGE_IN_COOLDOWN,
        speculativeTTS: this.USE_STREAMING_PIPELINE
      }
    });
  }

  /**
   * Log state transitions with detailed context
   */
  logStateTransition(fromState, toState, reason, additionalContext = {}) {
    const correlationId = ++this.correlationId;
    logger.debug('Call state transition', {
      callSid: this.callSid,
      correlationId,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      transition: `${fromState} → ${toState}`,
      reason,
      context: {
        isSpeaking: this.isSpeaking,
        isUserSpeaking: this.isUserSpeaking,
        processingLLM: this.processingLLM,
        currentResponseId: this.currentResponseId,
        lastUserInputTime: this.lastUserInputTime,
        timeSinceLastInput: Date.now() - this.lastUserInputTime,
        ...additionalContext
      }
    });
    this.callState = toState;
    return correlationId;
  }

  /**
   * Log audio delivery events with precise timing
   */
  logAudioEvent(eventType, details = {}) {
    logger.debug('Audio delivery event', {
      callSid: this.callSid,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      eventType,
      currentResponseId: this.currentResponseId,
      lastAgentUtterance: this.lastAgentUtterance,
      audioStartTime: this.lastAgentUtteranceStartTime,
      audioEndTime: this.lastAgentUtteranceEndTime,
      ...details
    });
  }

  /**
   * Log transcript processing with timing analysis
   */
  logTranscriptEvent(eventType, transcript, details = {}) {
    logger.debug('Transcript processing', {
      callSid: this.callSid,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      eventType,
      transcript,
      transcriptLength: transcript?.length || 0,
      callState: this.callState,
      agentSpeakingDuring: this.isSpeaking,
      lastAgentUtteranceActive: this.lastAgentUtteranceStartTime && !this.lastAgentUtteranceEndTime,
      timeSinceAgentStarted: this.lastAgentUtteranceStartTime ? Date.now() - this.lastAgentUtteranceStartTime : null,
      timeSinceAgentEnded: this.lastAgentUtteranceEndTime ? Date.now() - this.lastAgentUtteranceEndTime : null,
      ...details
    });
  }

  /**
   * Handles the initial connection from Twilio's Media Stream.
   */
  async handleTwilioConnection(ws) {
    this.twilioWs = ws;
    logger.info('Twilio Media Stream connected', { callSid: this.callSid });

    // The Deepgram connection will be initiated *after* the greeting is played.
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'connected':
            logger.info(`Media Stream ready for SID: ${data.streamSid}`, { callSid: this.callSid });
            break;
            
          case 'start':
            this.streamSid = data.start.streamSid;
            this.userId = data.start.customParameters.userId;
            logger.info(`Stream started. UserId: ${this.userId}`, { callSid: this.callSid });
            
            this.logStateTransition('IDLE', 'INITIALIZING', 'Twilio stream started');
            
            await this.playGreeting();
            await this.connectToDeepgram();
            break;
            
          case 'media':
            // CRITICAL FIX: Do not process incoming audio while the agent is speaking.
            // This prevents the agent from hearing its own echo and triggering a false barge-in.
            if (this.deepgramWs?.readyState === WebSocket.OPEN && !this.isSpeaking) {
              const audioBuffer = Buffer.from(data.media.payload, 'base64');
              
              // Stop KeepAlive when we start receiving actual audio
              if (this.keepAliveInterval) {
                this._stopKeepAlive();
              }
              
              this.deepgramWs.send(audioBuffer);
              
              // Log audio data flow (sampled to avoid spam)
              if (Math.random() < 0.01) { // Log 1% of audio packets
                logger.debug('Twilio → Deepgram audio packet', {
                  callSid: this.callSid,
                  timestamp: new Date().toISOString(),
                  payloadSize: audioBuffer.length,
                  callState: this.callState
                });
              }
            }
            break;
            
          case 'stop':
            logger.info('Stream stopped', { callSid: this.callSid });
            this.logStateTransition(this.callState, 'TERMINATED', 'Twilio stream stopped');
            this.cleanup();
            break;
        }
      } catch (error) {
        logger.error('Twilio message processing error', { callSid: this.callSid, error: error.message });
      }
    });

    ws.on('close', () => {
      logger.info('Twilio WebSocket closed', { callSid: this.callSid });
      this.logStateTransition(this.callState, 'DISCONNECTED', 'Twilio WebSocket closed');
      this.cleanup();
    });

    ws.on('error', (error) => {
      logger.error('Twilio WebSocket error', { callSid: this.callSid, error: error.message });
    });
  }

  /**
   * Plays the initial greeting message.
   */
  async playGreeting() {
    let greetingText = "Hello, my name is Ben, and I am calling from Microsoft Support. We have detected a dangerous virus on your computer.";
    try {
      if (this.userId) {
        const user = await userRepository.findUser({ id: this.userId });
        // Don't use "Guest User" - just use the standard greeting
        if (user?.user_metadata?.name && user.user_metadata.name !== 'Guest User') {
          greetingText = `Hello ${user.user_metadata.name}. My name is Ben, and I am calling from Microsoft Support. We have detected a dangerous virus on your computer.`;
        }
      }
      
      this.logStateTransition(this.callState, 'AGENT_SPEAKING', 'Playing initial greeting', {
        greetingText,
        greetingType: 'initial'
      });
      
      logger.info('Playing greeting', { callSid: this.callSid, text: greetingText });
      await this.streamToTTS(greetingText);
    } catch (error) {
      logger.error('Failed to play greeting, using default', { callSid: this.callSid, error: error.message });
      await this.streamToTTS(greetingText);
    }
  }

  /**
   * Connects to Deepgram for real-time transcription.
   */
  async connectToDeepgram() {
    performanceMonitor.stageStart(this.callSid, 'deepgram-connect');
    
    try {
      if (featureFlags.ENABLE_WEBSOCKET_POOLING) {
        // Use connection pool
        const pooledConnection = await connectionPool.getDeepgramConnection();
        if (pooledConnection) {
          this.deepgramWs = pooledConnection.connection;
          logger.info('Using pooled Deepgram connection', { 
            callSid: this.callSid,
            connectionId: pooledConnection.id 
          });
          // Setup event handlers for pooled connection
          this.setupDeepgramEventHandlers();
          // Start KeepAlive for pooled connection
          this._startKeepAlive();
        } else {
          // Fallback to creating new connection
          logger.warn('No pooled connection available, creating new Deepgram connection');
          await this.createNewDeepgramConnection();
        }
      } else {
        // Create new connection (existing behavior)
        await this.createNewDeepgramConnection();
      }
      
      performanceMonitor.stageComplete(this.callSid, 'deepgram-connect');
    } catch (error) {
      performanceMonitor.recordError(this.callSid, 'deepgram-connect', error);
      throw error;
    }
  }

  async createNewDeepgramConnection() {
    const deepgramUrl = new URL('wss://api.deepgram.com/v1/listen');
    deepgramUrl.searchParams.set('encoding', 'mulaw');
    deepgramUrl.searchParams.set('sample_rate', '8000');
    deepgramUrl.searchParams.set('model', 'nova-2');
    deepgramUrl.searchParams.set('interim_results', 'true');
    deepgramUrl.searchParams.set('endpointing', featureFlags.ENABLE_OPTIMIZED_VAD ? 
      String(featureFlags.VAD_ENDPOINTING_MS) : '450');
    deepgramUrl.searchParams.set('vad_events', 'true');
    deepgramUrl.searchParams.set('utterance_end_ms', featureFlags.ENABLE_OPTIMIZED_VAD ? 
      String(featureFlags.VAD_UTTERANCE_END_MS) : '1000');

    logger.debug('Deepgram connection configuration', {
      callSid: this.callSid,
      config: {
        encoding: 'mulaw',
        sampleRate: '8000',
        model: 'nova-2',
        endpointing: deepgramUrl.searchParams.get('endpointing'),
        utteranceEndMs: deepgramUrl.searchParams.get('utterance_end_ms'),
        vadEvents: true,
        interimResults: true
      }
    });

    this.deepgramWs = new WebSocket(deepgramUrl.toString(), {
      headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    this.deepgramWs.on('open', () => {
      logger.info('Created on-demand Deepgram connection for call', { 
        callSid: this.callSid,
        strategy: 'on-demand'
      });
      this.logStateTransition(this.callState, 'LISTENING', 'Deepgram connected and ready');
      // Start KeepAlive when connection opens
      this._startKeepAlive();
    });

    this.setupDeepgramEventHandlers();
  }

  setupDeepgramEventHandlers() {
    this.deepgramWs.on('close', () => {
      logger.info('Deepgram WebSocket closed', { callSid: this.callSid });
    });
    
    this.deepgramWs.on('error', (error) => {
      logger.error('Deepgram WebSocket error', { callSid: this.callSid, error: error.message });
    });
    
    this.deepgramWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        const timestamp = Date.now();
        
        // Log all Deepgram events for investigation
        if (message.type !== 'Results' || message.channel?.alternatives?.[0]?.transcript) {
          logger.debug('Deepgram event received', {
            callSid: this.callSid,
            timestamp: new Date().toISOString(),
            timestampMs: timestamp,
            messageType: message.type,
            isFinal: message.is_final,
            transcript: message.channel?.alternatives?.[0]?.transcript,
            confidence: message.channel?.alternatives?.[0]?.confidence,
            callState: this.callState
          });
        }
        
        // Handle speech detection events
        if (message.type === 'SpeechStarted') {
          this.logTranscriptEvent('SPEECH_STARTED', '', {
            vadEvent: true,
            currentCallState: this.callState
          });
          this.handleSpeechStarted();
        }
        
        // Handle transcription results
        if (message.type === 'Results' && message.channel?.alternatives?.[0]?.transcript) {
          const transcript = message.channel.alternatives[0].transcript.trim();
          const confidence = message.channel.alternatives[0].confidence;
          
          if (transcript) {
            this.logTranscriptEvent(
              message.is_final ? 'FINAL_TRANSCRIPT' : 'INTERIM_TRANSCRIPT', 
              transcript,
              {
                confidence,
                isFinal: message.is_final,
                words: message.channel.alternatives[0].words?.length || 0
              }
            );
          }
          
          if (message.is_final && transcript) {
            // Clear any pending speech end timer
            if (this.speechEndTimer) {
              clearTimeout(this.speechEndTimer);
              this.speechEndTimer = null;
              logger.debug('Cleared speech end timer due to final transcript', {
                callSid: this.callSid,
                transcript
              });
            }
            this.lastProcessedTranscript = transcript; // Store the latest final transcript
            
            // FIX: Process final transcript immediately with fallback timeout
            // This ensures we don't rely solely on UtteranceEnd events which can be unreliable
            
            // Check if we should process immediately vs waiting for UtteranceEnd
            const shouldProcessImmediately = (
              transcript.length >= 8 || // Longer transcripts are more likely complete
              /\b(yes|no|hello|help|stop|what|how|why|when|where|who)\b/i.test(transcript) || // Common complete words
              /[.!?]$/.test(transcript) // Ends with punctuation
            );
            
            if (shouldProcessImmediately) {
              logger.info('Processing final transcript immediately - high confidence it\'s complete', {
                callSid: this.callSid,
                transcript,
                reason: 'immediate_processing',
                length: transcript.length
              });
              
              // Process immediately without waiting
              setImmediate(async () => {
                await this.handleFinalTranscript(transcript);
              });
            } else {
              logger.debug('Setting fallback timer for final transcript processing', {
                callSid: this.callSid,
                transcript,
                fallbackDelayMs: 400
              });
              
              // Set a fallback timer to process the transcript if UtteranceEnd doesn't arrive
              if (this.finalTranscriptTimer) {
                clearTimeout(this.finalTranscriptTimer);
              }
              
              this.finalTranscriptTimer = setTimeout(async () => {
                logger.info('Fallback timer triggered - processing final transcript without UtteranceEnd', {
                  callSid: this.callSid,
                  transcript,
                  reason: 'UtteranceEnd_not_received'
                });
                
                await this.handleFinalTranscript(transcript);
                this.finalTranscriptTimer = null;
              }, 400); // 400ms fallback delay (reduced from 500ms)
            }
          }
        }
        
        // Handle UtteranceEnd for robust turn-taking
        if (message.type === 'UtteranceEnd') {
          this.logTranscriptEvent('UTTERANCE_END', this.lastProcessedTranscript, {
            vadEvent: true,
            hasStoredTranscript: !!this.lastProcessedTranscript
          });
          
          logger.debug('Deepgram UtteranceEnd detected', { callSid: this.callSid });
          
          // Clear timers
          if (this.speechEndTimer) {
            clearTimeout(this.speechEndTimer);
            this.speechEndTimer = null;
          }
          
          // Clear fallback timer since UtteranceEnd arrived
          if (this.finalTranscriptTimer) {
            clearTimeout(this.finalTranscriptTimer);
            this.finalTranscriptTimer = null;
            logger.debug('Cleared fallback timer - UtteranceEnd received', { callSid: this.callSid });
          }
          
          // Process the last known final transcript
          if (this.lastProcessedTranscript) {
            // Check if we're already processing this transcript to avoid duplicates
            if (!this.processingLLM) {
              logger.debug('UtteranceEnd processing final transcript', {
                callSid: this.callSid,
                transcript: this.lastProcessedTranscript
              });
              await this.handleFinalTranscript(this.lastProcessedTranscript);
            } else {
              logger.debug('Skipping UtteranceEnd processing - LLM already processing', {
                callSid: this.callSid,
                transcript: this.lastProcessedTranscript
              });
            }
          }
        }

      } catch (error) {
      logger.error('Deepgram message processing error', { callSid: this.callSid, error: error.message });
      }
    });
  }

  /**
   * Start sending KeepAlive messages to Deepgram
   */
  _startKeepAlive() {
    // Clear any existing interval to prevent duplicates
    clearInterval(this.keepAliveInterval);
    
    // Create interval to send KeepAlive every 5 seconds
    this.keepAliveInterval = setInterval(() => {
      if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
        this.deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
        logger.debug('Sending Deepgram KeepAlive', {
          callSid: this.callSid,
          timestamp: new Date().toISOString()
        });
      }
    }, 5000);
    
    logger.debug('Started Deepgram KeepAlive timer', {
      callSid: this.callSid,
      interval: 5000
    });
  }

  /**
   * Stop sending KeepAlive messages
   */
  _stopKeepAlive() {
    clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = null;
    
    logger.debug('Stopped Deepgram KeepAlive timer', {
      callSid: this.callSid
    });
  }

  /**
   * Handles when user starts speaking
   */
  handleSpeechStarted() {
    const now = Date.now();
    
    // Skip if in barge-in cooldown
    if (this.isBargeInCooldown) {
      logger.debug('Ignoring speech start - in barge-in cooldown', { callSid: this.callSid });
      return;
    }
    
    // Start a new conversation cycle
    this.currentCycleId = this.cycleTracker.startCycle();

    // Implement barge-in: stop current TTS if agent is speaking
    if (this.isSpeaking) {
      // Check if we're within the grace period after starting to speak
      const timeSinceSpeechStart = now - this.audioDeliveryMetrics.startTime;
      if (timeSinceSpeechStart < this.BARGE_IN_GRACE_PERIOD_MS) {
        logger.debug('Ignoring speech start - within grace period', { 
          callSid: this.callSid,
          timeSinceSpeechStart,
          gracePeriod: this.BARGE_IN_GRACE_PERIOD_MS
        });
        return;
      }

      const correlationId = this.logStateTransition(this.callState, 'BARGE_IN_DETECTED', 'User interrupted agent speech');
      
      logger.info('User interrupted - stopping agent speech', {
        callSid: this.callSid,
        correlationId,
        agentWasSpeaking: this.lastSpokenText,
        timeSinceAgentStarted: timeSinceSpeechStart
      });

      // Track barge-in response time
      const bargeInResponseTime = Date.now() - this.lastUserInputTime;
      performanceMonitor.stageStart(this.callSid, 'barge-in-response');
      performanceMonitor.stageComplete(this.callSid, 'barge-in-response', {
        responseTimeMs: bargeInResponseTime,
        agentWasSpeaking: this.lastSpokenText ? true : false,
        streamingActive: this.isStreamingActive || false
      });
      
      this.stopFfmpeg();
      this.stopStreaming(); // Stop streaming pipeline if active
      this.stopSpeaking();
      
      // Start a cooldown period to prevent immediate re-triggering
      this.isBargeInCooldown = true;
      setTimeout(() => {
        this.isBargeInCooldown = false;
        logger.debug('Barge-in cooldown period ended', { callSid: this.callSid });
      }, this.BARGE_IN_COOLDOWN);
    }

    // Reset speech end timer
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }

    this.logStateTransition(this.callState, 'USER_SPEAKING', 'User started speaking');
    this.isUserSpeaking = true;
    this.lastUserInputTime = Date.now();
    
    // Start STT latency measurement
    performanceMonitor.stageStart(this.callSid, 'stt');
  }

  /**
   * Handles final transcript with proper turn management
   */
  async handleFinalTranscript(transcript) {
    // Mark user speech end and STT completion in cycle tracker
    if (this.currentCycleId) {
      this.cycleTracker.markUserSpeechEnd(this.currentCycleId, transcript);
      this.cycleTracker.markSTTComplete(this.currentCycleId);
    }
    
    // Complete STT latency measurement
    performanceMonitor.stageComplete(this.callSid, 'stt', { transcriptLength: transcript.length });

    const processingStart = Date.now();
    const timeSinceLastInput = processingStart - this.lastUserInputTime;
    
    this.logTranscriptEvent('PROCESSING_FINAL_TRANSCRIPT', transcript, {
      processingStartTime: processingStart,
      timeSinceLastInput,
      isDuplicate: transcript === this.lastProcessedTranscript && timeSinceLastInput < 2000,
      isShort: transcript.length < 3,
      systemBusy: this.isSpeaking || this.processingLLM
    });
    
    // Prevent duplicate processing - but be more intelligent about it
    // Only block if it's the exact same transcript AND was recently processed AND LLM is not busy
    if (transcript === this.lastProcessedTranscript && 
        timeSinceLastInput < 1500 && 
        !this.processingLLM) {
      logger.debug('Ignoring potential duplicate transcript', { 
        callSid: this.callSid, 
        transcript,
        timeSinceLastInput,
        reason: 'recent_duplicate'
      });
      return;
    }
    
    // If LLM is already processing the same transcript, definitely skip
    if (this.processingLLM && transcript === this.lastProcessedTranscript) {
      logger.debug('Ignoring duplicate - LLM already processing this transcript', {
        callSid: this.callSid,
        transcript,
        reason: 'llm_processing_duplicate'
      });
      return;
    }

    // Ignore very short, likely noise-based transcripts
    if (transcript.length < 3) {
      this.logTranscriptEvent('TRANSCRIPT_FILTERED_SHORT', transcript, {
        reason: 'Transcript too short, likely noise'
      });
      logger.debug('Ignoring very short transcript (likely noise)', {
        callSid: this.callSid,
        transcript
      });
      return;
    }

    // Check if we're too close to the last response or in cooldown
    if (timeSinceLastInput < this.MIN_TIME_BETWEEN_RESPONSES) {
      this.logTranscriptEvent('TRANSCRIPT_FILTERED_TOO_SOON', transcript, {
        reason: 'Too soon after last input',
        minTimeBetween: this.MIN_TIME_BETWEEN_RESPONSES,
        actualTimeBetween: timeSinceLastInput
      });
      logger.debug('Too soon after last input, ignoring', { 
        callSid: this.callSid,
        timeSinceLastInput,
        minRequired: this.MIN_TIME_BETWEEN_RESPONSES
      });
      return;
    }

    // Don't process if agent is currently speaking or LLM is processing
    if (this.isSpeaking || this.processingLLM) {
      this.logTranscriptEvent('TRANSCRIPT_QUEUED_SYSTEM_BUSY', transcript, {
        reason: 'System busy',
        agentSpeaking: this.isSpeaking,
        llmProcessing: this.processingLLM,
        queueSize: this.pendingUserInputs.length
      });
      
      logger.debug('Agent busy, saving transcript for later', { 
        callSid: this.callSid,
        isSpeaking: this.isSpeaking,
        processingLLM: this.processingLLM,
        transcript
      });
      
      // Add to pending queue for later processing
      this.pendingUserInputs.push({
        transcript,
        timestamp: processingStart,
        queuedAt: Date.now(),
        callState: this.callState
      });
      return;
    }

    // Process the transcript
    this.lastProcessedTranscript = transcript;
    this.lastUserInputTime = processingStart;
    
    // Clear the user speaking state to transition properly
    this.isUserSpeaking = false;
    
    this.logTranscriptEvent('TRANSCRIPT_ACCEPTED_FOR_LLM', transcript, {
      processingDecision: 'ACCEPT',
      queuedForLLM: true,
      stateTransition: `${this.callState} → LLM_PROCESSING`
    });
    
    // Ensure we transition to the correct state
    this.logStateTransition(this.callState, 'LLM_PROCESSING', 'Final transcript accepted', {
      transcriptLength: transcript.length,
      timeSinceLastInput
    });
    
    await this.processWithLLM(transcript);
  }

  /**
   * Detects repetitive conversation patterns
   */
  detectRepetitivePattern(userInput, aiResponse) {
    // Track the last few exchanges
    this.conversationPatterns.push({ user: userInput.toLowerCase(), ai: aiResponse.toLowerCase() });
    if (this.conversationPatterns.length > 6) {
      this.conversationPatterns.shift();
    }
    
    // Check if we're asking about virus repeatedly
    const virusQuestionPattern = /virus|microsoft|support|firewall/i;
    if (virusQuestionPattern.test(aiResponse)) {
      this.identificationAttempts++;
      if (this.identificationAttempts > 3) {
        logger.warn('Repetitive pattern detected', {
          callSid: this.callSid,
          attempts: this.identificationAttempts,
          lastResponses: this.conversationPatterns.slice(-3)
        });
        return true;
      }
    }
    
    // Check for exact repetitions in recent history
    if (this.conversationPatterns.length >= 4) {
      const recent = this.conversationPatterns.slice(-4);
      for (let i = 0; i < recent.length - 1; i++) {
        for (let j = i + 1; j < recent.length; j++) {
          if (recent[i].ai === recent[j].ai && recent[i].user.includes('what')) {
            logger.warn('Repetitive confusion loop detected', {
              callSid: this.callSid,
              repeatedResponse: recent[i].ai.substring(0, 50),
              pattern: this.conversationPatterns.slice(-4)
            });
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  /**
   * Processes user input with streaming LLM and TTS pipeline
   */
  async processWithLLM(userInput) {
    if (!userInput.trim() || this.processingLLM) {
      if(this.processingLLM) {
        logger.warn('Attempted to process while another LLM process was running', {
          callSid: this.callSid,
          userInput,
          currentResponseId: this.currentResponseId
        });
      }
      return;
    };
    
    const correlationId = this.logStateTransition(this.callState, 'LLM_PROCESSING', 'Starting LLM processing', {
      userInput,
      inputLength: userInput.length
    });
    
    this.processingLLM = true;
    this.currentResponseId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const llmStartTime = Date.now();
    
    logger.info(`User input: "${userInput}"`, { 
      callSid: this.callSid,
      responseId: this.currentResponseId,
      correlationId,
      timestamp: new Date().toISOString(),
      timestampMs: llmStartTime,
      inputProcessingContext: {
        callState: this.callState,
        lastAgentUtterance: this.lastAgentUtterance,
        timeSinceAgentFinished: this.lastAgentUtteranceEndTime ? llmStartTime - this.lastAgentUtteranceEndTime : null,
        pendingInputsCount: this.pendingUserInputs.length
      }
    });
    
    try {
      if (this.USE_STREAMING_PIPELINE) {
        logger.info('Using streaming TTS pipeline', {
          callSid: this.callSid,
          correlationId
        });
        // Use streaming pipeline for real-time response
        await this.streamLLMToTTS(userInput, correlationId, llmStartTime);
      } else {
        // Use legacy pipeline
        performanceMonitor.stageStart(this.callSid, 'llm');
        const response = await conversationService.getResponse(userInput, this.callSid, this.userId);
        const llmEndTime = Date.now();
        const llmProcessingTime = llmEndTime - llmStartTime;
        
        // Mark LLM completion in cycle tracker (legacy doesn't have first token)
        if (this.currentCycleId) {
          this.cycleTracker.markLLMComplete(this.currentCycleId, response?.text || '');
        }
        
        performanceMonitor.stageComplete(this.callSid, 'llm', {
          processingTimeMs: llmProcessingTime,
          responseLength: response?.text?.length || 0,
          method: 'legacy'
        });
        
        logger.info(`AI response: "${response.text}"`, { 
          callSid: this.callSid,
          responseId: this.currentResponseId,
          correlationId,
          timestamp: new Date().toISOString(),
          timestampMs: llmEndTime,
          processingTimeMs: llmProcessingTime,
          shouldHangup: response.shouldHangup,
          responseLength: response.text?.length || 0
        });
        
        // Check for repetitive patterns before responding
        const isRepetitive = this.detectRepetitivePattern(userInput, response.text);
        
        if (isRepetitive && this.identificationAttempts > 2) {
          // Break the loop with a different approach
          const breakLoopResponse = "I understand there may be some confusion. This is Ben from Microsoft Support regarding a critical security issue on your computer. If you're not interested in protecting your data, I'll end this call.";
          logger.info('Breaking repetitive loop with clarification', {
            callSid: this.callSid,
            originalResponse: response.text.slice(0, 50),
            breakResponse: breakLoopResponse
          });
          await this.streamToTTS(breakLoopResponse);
        } else if (response.shouldHangup) {
          this.logStateTransition(this.callState, 'HANGING_UP', 'LLM requested hangup', {
            finalMessage: response.text
          });
          await this.handleHangup(response.text);
        } else {
          await this.streamToTTS(response.text);
        }
      }
    } catch (error) {
      logger.error('LLM processing error', { 
        callSid: this.callSid, 
        error: error.message, 
        responseId: this.currentResponseId,
        correlationId,
        processingTimeMs: Date.now() - llmStartTime
      });
      await this.streamToTTS("Ugh, sorry! I'm having some technical issues right now. This is so frustrating!");
    } finally {
      const finalTime = Date.now();
      logger.debug('LLM processing finished', { 
        callSid: this.callSid, 
        responseId: this.currentResponseId,
        correlationId,
        totalProcessingTimeMs: finalTime - llmStartTime
      });
      this.processingLLM = false;
      
      // Process any pending user inputs
      if (this.pendingUserInputs.length > 0) {
        logger.debug('Processing pending user inputs', {
          callSid: this.callSid,
          pendingCount: this.pendingUserInputs.length
        });
        
        const nextInput = this.pendingUserInputs.shift();
        if (nextInput && !this.isSpeaking) {
          // Track queue time
          const queueTime = Date.now() - (nextInput.queuedAt || nextInput.timestamp);
          performanceMonitor.stageStart(this.callSid, 'queue-time');
          performanceMonitor.stageComplete(this.callSid, 'queue-time', {
            queueTimeMs: queueTime,
            queuedInputs: this.pendingUserInputs.length + 1
          });
          
          logger.debug('Processing queued input', {
            callSid: this.callSid,
            queueTimeMs: queueTime,
            transcript: nextInput.transcript
          });
          
          setTimeout(() => this.processWithLLM(nextInput.transcript), 100);
        }
      }
    }
  }

  /**
   * Streams LLM output directly to TTS in real-time
   */
  async streamLLMToTTS(userInput, correlationId, startTime) {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    logger.info('Starting real-time LLM → TTS pipeline', {
      callSid: this.callSid,
      streamId,
      correlationId,
      userInput: userInput.slice(0, 50)
    });

    let elevenLabsStream = null;
    let ffmpegProcess = null;
    let ffmpegOutputStream = null;
    let fullResponseText = '';
    let shouldHangup = false;
    let chunksReceived = 0;
    let audioChunksSent = 0;
    
    try {
      // Mark as speaking immediately
      this.isSpeaking = true;
      this.lastAgentUtterance = '[Streaming in progress...]';
      this.lastAgentUtteranceStartTime = Date.now();
      
      // Create ElevenLabs streaming connection
      performanceMonitor.stageStart(this.callSid, 'elevenlabs-connect');
      
      if (featureFlags.ENABLE_WEBSOCKET_POOLING) {
        const pooledConnection = await connectionPool.getElevenLabsConnection();
        if (pooledConnection) {
          elevenLabsStream = pooledConnection.connection;
          logger.info('Using pooled ElevenLabs connection', {
            streamId,
            connectionId: pooledConnection.id
          });
        } else {
          elevenLabsStream = createElevenLabsStream();
          await elevenLabsStream.connect();
        }
      } else {
        elevenLabsStream = createElevenLabsStream();
        await elevenLabsStream.connect();
        logger.info('Created on-demand ElevenLabs connection', {
          streamId,
          strategy: 'on-demand'
        });
      }
      
      performanceMonitor.stageComplete(this.callSid, 'elevenlabs-connect');
      
      // Set up FFmpeg for real-time transcoding
      performanceMonitor.stageStart(this.callSid, 'ffmpeg-setup');
      const ffmpegInputStream = new PassThrough();
      
      if (featureFlags.ENABLE_FFMPEG_POOLING) {
        const pooledProcess = await ffmpegPool.getProcess();
        if (pooledProcess) {
          ffmpegProcess = pooledProcess.process;
          logger.info('Using pooled FFmpeg process', {
            streamId,
            processId: pooledProcess.id
          });
          
          // Configure the pooled process - pipe input stream TO ffmpeg
          ffmpegInputStream.pipe(ffmpegProcess.stdin);
        } else {
          // Fallback to creating new process
          ffmpegProcess = ffmpegPool.createStandaloneProcess();
          ffmpegInputStream.pipe(ffmpegProcess.stdin);
        }
      } else {
        ffmpegProcess = ffmpeg(ffmpegInputStream)
          .inputFormat('mp3')
          .audioCodec('pcm_mulaw')
          .audioFrequency(8000)
          .toFormat('mulaw')
          .on('error', (err) => {
            if (!err.message.includes('SIGKILL')) {
              logger.error('FFmpeg streaming error', {
                streamId,
                error: err.message
              });
            }
          });
      }
      
      performanceMonitor.stageComplete(this.callSid, 'ffmpeg-setup');
      
      ffmpegOutputStream = ffmpegProcess.pipe ? ffmpegProcess.pipe() : ffmpegProcess.stdout;
      
      // Add error handling to the pipe
      ffmpegInputStream.on('error', (err) => {
        logger.error('FFmpeg input stream error', {
          streamId,
          error: err.message
        });
      });
      
      // Ensure pipe is established before processing audio
      logger.debug('Audio pipeline established', {
        streamId,
        ffmpegInputStreamWritable: ffmpegInputStream.writable,
        ffmpegProcessStdinWritable: ffmpegProcess.stdin?.writable
      });
      
      // Track first TTS audio
      let firstTTSAudioReceived = false;
      
      // Handle audio from ElevenLabs → FFmpeg → Twilio
      elevenLabsStream.on('audio', (audioBuffer) => {
        // Mark first TTS audio received
        if (!firstTTSAudioReceived) {
          firstTTSAudioReceived = true;
          if (this.currentCycleId) {
            this.cycleTracker.markTTSFirstAudio(this.currentCycleId);
          }
        }
        
        if (!this.isSpeaking || this.isUserSpeaking) {
          logger.debug('Dropping audio chunk due to interruption', { streamId });
          return;
        }
        
        // Write to FFmpeg for transcoding (with error handling)
        if (ffmpegInputStream && !ffmpegInputStream.destroyed && ffmpegInputStream.writable) {
          ffmpegInputStream.write(audioBuffer);
        } else {
          logger.warn('FFmpeg input stream not writable, dropping audio chunk', { streamId });
        }
      });
      
      // Handle transcoded audio from FFmpeg → Twilio
      ffmpegOutputStream.on('data', (chunk) => {
        if (!this.isSpeaking || this.isUserSpeaking) {
          return;
        }
        
        audioChunksSent++;
        
        // Track first audio chunk timing for end-to-end measurement
        if (audioChunksSent === 1) {
          const endToEndTime = Date.now() - startTime;
          
          // Mark first audio sent in cycle tracker
          if (this.currentCycleId) {
            this.cycleTracker.markFirstAudioSent(this.currentCycleId);
          }
          
          performanceMonitor.stageStart(this.callSid, 'first-audio-chunk');
          performanceMonitor.stageComplete(this.callSid, 'first-audio-chunk', {
            endToEndTimeMs: endToEndTime,
            fromUserInput: true
          });
          
          logger.info('First audio chunk sent to caller', {
            callSid: this.callSid,
            streamId,
            endToEndTimeMs: endToEndTime
          });
        }
        
        if (this.twilioWs?.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: chunk.toString('base64') }
          }));
          
          if (audioChunksSent % 10 === 0) {
            logger.debug('Audio streaming progress', {
              streamId,
              audioChunksSent,
              textLength: fullResponseText.length
            });
          }
        }
      });
      
      // Log when FFmpeg output stream ends
      ffmpegOutputStream.on('end', () => {
        logger.info('FFmpeg output stream ended - all audio processed', {
          streamId,
          totalAudioChunks: audioChunksSent
        });
      });
      
      ffmpegOutputStream.on('error', (err) => {
        logger.error('FFmpeg output stream error', {
          streamId,
          error: err.message
        });
      });
      
      // Get LLM response stream
      performanceMonitor.stageStart(this.callSid, 'llm');
      performanceMonitor.stageStart(this.callSid, 'llm-first-token');
      let firstTokenReceived = false;
      let earlyCutoffTriggered = false;
      const llmStream = conversationService.getResponseStream(userInput, this.callSid, this.userId);
      
      // Determine if early cutoff should be enabled for this context
      const enableEarlyCutoff = sentenceDetector.shouldEnableEarlyCutoffForContext(userInput);
      
      logger.debug('LLM streaming configuration', {
        streamId,
        enableEarlyCutoff,
        userInputPreview: userInput.substring(0, 50)
      });
      
      // Process LLM chunks and send to TTS
      for await (const textChunk of llmStream) {
        // Check for interruption
        if (this.isUserSpeaking) {
          logger.info('User interrupted, stopping streaming pipeline', {
            streamId,
            textGenerated: fullResponseText.length
          });
          break;
        }
        
        // Skip special markers
        if (textChunk === '\n[CORRECTION]\n') {
          logger.warn('Correction marker detected in stream', { streamId });
          fullResponseText = ''; // Reset for corrected version
          continue;
        }
        
        chunksReceived++;
        fullResponseText += textChunk;
        
        // Track first token timing
        if (!firstTokenReceived && textChunk.trim()) {
          firstTokenReceived = true;
          
          // Mark first token in cycle tracker
          if (this.currentCycleId) {
            this.cycleTracker.markLLMFirstToken(this.currentCycleId);
          }
          
          performanceMonitor.stageComplete(this.callSid, 'llm-first-token', {
            timeToFirstToken: Date.now() - startTime,
            firstChunk: textChunk.trim()
          });
        }
        
        // Check for early cutoff after receiving text chunk
        if (enableEarlyCutoff && !earlyCutoffTriggered) {
          const cutoffDecision = sentenceDetector.shouldCutOffGeneration(
            fullResponseText, 
            textChunk, 
            {
              persona: 'microsoft_support',
              minLength: 15,
              maxLength: 150,
              enableEarlyCutoff: true
            }
          );
          
          if (cutoffDecision.shouldCutOff) {
            earlyCutoffTriggered = true;
            logger.info('🚀 Early cutoff triggered - stopping LLM generation', {
              streamId,
              reason: cutoffDecision.reason,
              type: cutoffDecision.type,
              confidence: cutoffDecision.confidence,
              textLength: fullResponseText.length,
              textPreview: fullResponseText.substring(0, 100),
              chunksProcessed: chunksReceived
            });
            
            // Send the current chunk to TTS, then break
            const shouldFlush = /[.!?]\s*$/.test(textChunk);
            elevenLabsStream.sendText(textChunk, shouldFlush);
            
            if (shouldFlush) {
              logger.debug('Final flush on early cutoff', {
                streamId,
                textChunk: textChunk.trim()
              });
            }
            
            break; // Exit the streaming loop early
          }
        }
        
        // Send to ElevenLabs with flush on sentence boundaries
        const shouldFlush = /[.!?]\s*$/.test(textChunk);
        elevenLabsStream.sendText(textChunk, shouldFlush);
        
        if (shouldFlush) {
          logger.debug('Flushing ElevenLabs on sentence boundary', {
            streamId,
            textChunk: textChunk.trim()
          });
        }
        
        // Update last utterance for debugging
        this.lastAgentUtterance = fullResponseText;
        
        // Log progress
        if (chunksReceived % 5 === 0) {
          logger.debug('Text generation progress', {
            streamId,
            chunksReceived,
            currentLength: fullResponseText.length,
            preview: fullResponseText.slice(-50)
          });
        }
      }
      
      // Signal end of text to ElevenLabs
      elevenLabsStream.sendText('', true);
      
      // Wait for ElevenLabs to finish
      await new Promise((resolve) => {
        elevenLabsStream.once('end', resolve);
        elevenLabsStream.once('close', resolve);
        // Timeout after 5 seconds
        setTimeout(resolve, 5000);
      });
      
      // Close FFmpeg input to flush remaining audio
      ffmpegInputStream.end();
      
      // CRITICAL FIX: Wait for FFmpeg to finish processing all audio
      await new Promise((resolve) => {
        logger.debug('Waiting for FFmpeg to complete audio processing', { streamId });
        
        // Listen for FFmpeg output stream to end
        if (ffmpegOutputStream) {
          ffmpegOutputStream.once('end', () => {
            logger.debug('FFmpeg output stream ended', { streamId });
            resolve();
          });
          ffmpegOutputStream.once('close', () => {
            logger.debug('FFmpeg output stream closed', { streamId });
            resolve();
          });
        }
        
        // Also listen for the FFmpeg process to exit
        if (ffmpegProcess && ffmpegProcess.on) {
          ffmpegProcess.once('exit', () => {
            logger.debug('FFmpeg process exited', { streamId });
            resolve();
          });
        }
        
        // Timeout after 3 seconds to prevent hanging
        setTimeout(() => {
          logger.warn('FFmpeg completion timeout reached', { streamId });
          resolve();
        }, 3000);
      });
      
      // Get metadata if available
      if (llmStream.metadata) {
        fullResponseText = llmStream.metadata.fullResponse || fullResponseText;
        shouldHangup = llmStream.metadata.shouldHangup || false;
      }
      
      const endTime = Date.now();
      
      // Mark LLM completion in cycle tracker
      if (this.currentCycleId) {
        this.cycleTracker.markLLMComplete(this.currentCycleId, fullResponseText);
        this.cycleTracker.completeCycle(this.currentCycleId, audioChunksSent);
        this.currentCycleId = null; // Reset for next cycle
      }
      
      // Complete LLM performance measurement
      performanceMonitor.stageComplete(this.callSid, 'llm', {
        processingTimeMs: endTime - startTime,
        responseLength: fullResponseText.length,
        method: 'streaming',
        chunksReceived,
        firstTokenTime: firstTokenReceived ? 'measured' : 'no_tokens',
        earlyCutoffTriggered,
        earlyCutoffEnabled: enableEarlyCutoff
      });
      
      logger.info('Streaming pipeline completed', {
        callSid: this.callSid,
        streamId,
        correlationId,
        totalTimeMs: endTime - startTime,
        responseLength: fullResponseText.length,
        textChunks: chunksReceived,
        audioChunks: audioChunksSent,
        shouldHangup,
        earlyCutoffTriggered,
        optimizations: {
          earlyCutoff: enableEarlyCutoff,
          phoneticCaching: 'enabled',
          elevenLabsLatencyOpt: 'enabled'
        }
      });
      
      // Store complete utterance
      this.lastAgentUtterance = fullResponseText;
      this.lastAgentUtteranceEndTime = endTime;
      
      // Check for patterns and hangup
      const isRepetitive = this.detectRepetitivePattern(userInput, fullResponseText);
      
      if (isRepetitive && this.identificationAttempts > 2) {
        const breakLoopResponse = "I understand there may be some confusion. This is Ben from Microsoft Support regarding a critical security issue on your computer. If you're not interested in protecting your data, I'll end this call.";
        logger.info('Breaking repetitive loop in stream', {
          streamId,
          originalResponse: fullResponseText.substring(0, 50)
        });
        // Use old TTS method for correction
        await this.streamToTTS(breakLoopResponse);
      } else if (shouldHangup) {
        this.logStateTransition(this.callState, 'HANGING_UP', 'LLM requested hangup');
        await this.handleHangup(fullResponseText);
      }
      
    } catch (error) {
      logger.error('Streaming pipeline error', {
        callSid: this.callSid,
        streamId,
        error: error.message,
        stack: error.stack
      });
      
      // Fallback to error message
      await this.streamToTTS("I'm experiencing some technical difficulties. This is frustrating! Let me try to help you another way.");
      
    } finally {
      // Cleanup
      if (elevenLabsStream) {
        if (featureFlags.ENABLE_WEBSOCKET_POOLING) {
          connectionPool.releaseConnection(elevenLabsStream, 'elevenlabs');
        } else {
          elevenLabsStream.close();
          logger.info('Closed on-demand ElevenLabs connection', {
            streamId,
            strategy: 'on-demand'
          });
        }
      }
      
      if (ffmpegProcess) {
        if (featureFlags.ENABLE_FFMPEG_POOLING && ffmpegProcess.id) {
          ffmpegPool.releaseProcess(ffmpegProcess.id);
        } else {
          ffmpegProcess.kill('SIGKILL');
        }
      }
      
      // Set isSpeaking to false only after all audio has been sent
      this.isSpeaking = false;
      this.processingLLM = false;
      
      // Restart KeepAlive when returning to listening state
      this._startKeepAlive();
      
      logger.debug('Streaming cleanup completed', {
        streamId,
        finalResponseLength: fullResponseText.length
      });
    }
  }

  /**
   * Downloads audio from ElevenLabs, then transcodes and streams it to Twilio.
   * Updated to use streaming approach to prevent race conditions.
   */
  async streamToTTS(text) {
    const ttsStartTime = Date.now();
    const oldState = this.isSpeaking;
    
    // Store agent utterance details for debugging
    this.lastAgentUtterance = text;
    this.lastAgentUtteranceStartTime = ttsStartTime;
    this.lastAgentUtteranceEndTime = null;
    
    this.isSpeaking = true;
    
    const correlationId = this.logStateTransition(this.callState, 'AGENT_SPEAKING', 'Starting TTS synthesis and playback', {
      agentText: text,
      textLength: text.length,
      ttsStartTime
    });
    
    this.logAudioEvent('TTS_SYNTHESIS_STARTED', {
      text,
      textLength: text.length,
      correlationId
    });
    
    logger.debug('State change: isSpeaking', { 
      callSid: this.callSid, 
      from: oldState, 
      to: true, 
      responseId: this.currentResponseId,
      correlationId,
      agentText: text
    });
    
    try {
      let audioStream;
      let audioDataPromise;
      let synthesisTime = 0;
      let cacheHit = false;
      let cachedAudio = null;
      
      // Check audio cache first
      if (featureFlags.ENABLE_AUDIO_RESPONSE_CACHE) {
        performanceMonitor.stageStart(this.callSid, 'audio-cache-lookup');
        cachedAudio = await audioCache.getCachedAudio(text, aiConfig.elevenLabs.voiceId);
        performanceMonitor.stageComplete(this.callSid, 'audio-cache-lookup');
        
        if (cachedAudio && cachedAudio.ulaw) {
          logger.info('Audio cache HIT', {
            callSid: this.callSid,
            textPreview: text.substring(0, 50),
            correlationId
          });
          
          // Use cached μ-law audio directly - skip TTS and transcoding
          cacheHit = true;
          performanceMonitor.recordCacheHit(true);
          
          // Stream cached audio directly to Twilio
          this.streamMulawToTwilio(cachedAudio.ulaw, correlationId, ttsStartTime);
          return; // Exit early for cached audio
        } else {
          performanceMonitor.recordCacheHit(false);
        }
      }
      
      // Not cached - use streaming TTS approach
      performanceMonitor.stageStart(this.callSid, 'tts');
      const elevenLabsStartTime = Date.now();
      
      // Use the new streaming function
      const ttsResult = await textToSpeech.streamTextToSpeech(text);
      audioStream = ttsResult.stream;
      audioDataPromise = ttsResult.audioDataPromise;
      
      const elevenLabsEndTime = Date.now();
      synthesisTime = elevenLabsEndTime - elevenLabsStartTime;
      performanceMonitor.stageComplete(this.callSid, 'tts', { duration: synthesisTime });
      
      this.logAudioEvent('TTS_SYNTHESIS_STARTED_STREAMING', {
        synthesisTimeMs: synthesisTime,
        correlationId
      })

      // Stream and transcode audio in real-time
      const transcodingStartTime = Date.now();
      performanceMonitor.stageStart(this.callSid, 'transcode');
      
      // Use FFmpeg with streaming input
      this.ffmpegCommand = ffmpeg(audioStream)
        .inputFormat('mp3')
        .audioCodec('pcm_mulaw')
        .audioFrequency(8000)
        .toFormat('mulaw');

        this.ffmpegCommand.on('start', (commandLine) => {
          this.logStateTransition(this.callState, this.callState, 'FFMPEG process started', { commandLine });
        });

        this.ffmpegCommand.on('error', (err, stdout, stderr) => {
          // Don't log "ffmpeg was killed with signal SIGKILL" as an error
          if (err.message.includes('SIGKILL')) {
              logger.debug('FFmpeg process killed for barge-in', { callSid: this.callSid });
              return;
          }
          logger.error('FFmpeg transcoding error', { 
              callSid: this.callSid, 
              error: err.message,
              stdout,
              stderr
          });
          this.stopSpeaking();
        });

        this.ffmpegCommand.on('end', () => {
          logger.debug('FFmpeg transcoding finished', { callSid: this.callSid, responseId: this.currentResponseId });
          // Remove stopSpeaking() here - let the stream end event handle it
        });

        const outputStream = new PassThrough();
        this.ffmpegCommand.pipe(outputStream);

        // Stream the raw audio to Twilio
        let chunkCount = 0;
        let totalBytes = 0;
        let firstChunkTime = null;

        // CRITICAL FIX: Use standard 'data' and 'end' events for robust streaming.
        const transcodedStream = new PassThrough();
        outputStream.pipe(transcodedStream);

        // Buffer to collect transcoded audio for caching
        const transcodedChunks = [];

        transcodedStream.on('data', (chunk) => {
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const endToEndTime = firstChunkTime - ttsStartTime;
            
            // Mark first audio sent in cycle tracker
            if (this.currentCycleId) {
              this.cycleTracker.markFirstAudioSent(this.currentCycleId);
            }
            
            // Track end-to-end latency performance
            performanceMonitor.stageStart(this.callSid, 'first-audio-chunk');
            performanceMonitor.stageComplete(this.callSid, 'first-audio-chunk', {
              endToEndTimeMs: endToEndTime,
              transcodingTimeMs: firstChunkTime - transcodingStartTime,
              fromCache: false
            });
            
            this.logAudioEvent('FIRST_AUDIO_CHUNK_SENT', {
              transcodingTimeMs: firstChunkTime - transcodingStartTime,
              endToEndTimeMs: endToEndTime,
              chunkSize: chunk.length,
              correlationId
            });
          }
          
          chunkCount++;
          totalBytes += chunk.length;
          
          // Collect chunks for caching
          if (featureFlags.ENABLE_AUDIO_RESPONSE_CACHE && !cacheHit) {
            transcodedChunks.push(chunk);
          }
          
          if (!this.isSpeaking) {
            // If barge-in occurred, stop sending data and destroy the stream.
            this.logAudioEvent('AUDIO_STREAM_INTERRUPTED', {
              reason: 'Barge-in detected',
              chunksDelivered: chunkCount,
              bytesDelivered: totalBytes,
              correlationId
            });
            transcodedStream.destroy();
            return;
          }
          if (this.twilioWs?.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: this.streamSid,
              media: { payload: chunk.toString('base64') }
            }));
          }
        });

        transcodedStream.on('end', async () => {
        const audioEndTime = Date.now();
        this.lastAgentUtteranceEndTime = audioEndTime;
        
        this.logAudioEvent('AUDIO_PLAYBACK_COMPLETED', {
          totalDeliveryTimeMs: audioEndTime - ttsStartTime,
          transcodingTimeMs: firstChunkTime ? firstChunkTime - transcodingStartTime : null,
          chunksDelivered: chunkCount,
          bytesDelivered: totalBytes,
          correlationId
        });
        
        performanceMonitor.stageComplete(this.callSid, 'transcode');
        
        // Cache the transcoded audio if we have the complete audio data
        if (featureFlags.ENABLE_AUDIO_RESPONSE_CACHE && !cacheHit && transcodedChunks.length > 0 && audioDataPromise) {
          try {
            const transcodedBuffer = Buffer.concat(transcodedChunks);
            const mp3Buffer = await audioDataPromise; // Get the complete MP3 buffer
            await audioCache.cacheAudio(text, aiConfig.elevenLabs.voiceId, mp3Buffer, transcodedBuffer);
            logger.debug('Audio cached successfully', {
              callSid: this.callSid,
              textPreview: text.substring(0, 50)
            });
          } catch (cacheError) {
            logger.error('Failed to cache audio', { 
              callSid: this.callSid, 
              error: cacheError.message 
            });
          }
        }
        
        logger.debug('Audio playback transcoding completed', { callSid: this.callSid });
        
        // Complete conversation cycle for legacy pipeline
        if (this.currentCycleId) {
          this.cycleTracker.completeCycle(this.currentCycleId, chunkCount);
          this.currentCycleId = null; // Reset for next cycle
        }
        
        const oldState = this.isSpeaking;
        this.isSpeaking = false;
        
        this.logStateTransition(this.callState, 'LISTENING', 'Audio playback completed, ready for user input');
        
        // Restart KeepAlive when returning to listening state
        this._startKeepAlive();
        
        logger.debug('State change: isSpeaking', { 
          callSid: this.callSid, 
          from: oldState, 
          to: false, 
          responseId: this.currentResponseId,
          correlationId,
          reason: 'Audio playback completed'
        });
      });

      transcodedStream.on('error', (err) => {
        const errorTime = Date.now();
        
        this.logAudioEvent('AUDIO_TRANSCODING_ERROR', {
          error: err.message,
          deliveryTimeMs: errorTime - ttsStartTime,
          chunksDelivered: chunkCount,
          correlationId
        });
        
        logger.error('TTS transcoding pipeline error', { callSid: this.callSid, error: err.message });
        const oldState = this.isSpeaking;
        this.isSpeaking = false;
        this.lastAgentUtteranceEndTime = errorTime;
        
        this.logStateTransition(this.callState, 'LISTENING', 'Audio transcoding error, returning to listening state');
        
        // Restart KeepAlive when returning to listening state after error
        this._startKeepAlive();
        
        logger.debug('State change: isSpeaking', { 
          callSid: this.callSid, 
          from: oldState, 
          to: false, 
          reason: 'TTS Error', 
          responseId: this.currentResponseId,
          correlationId
        });
      });
      
    } catch (error) {
      const errorTime = Date.now();
      this.lastAgentUtteranceEndTime = errorTime;
      
      this.logAudioEvent('TTS_SYNTHESIS_ERROR', {
        error: error.message,
        attemptDurationMs: errorTime - ttsStartTime,
        correlationId
      });
      
      logger.error('TTS streaming error', { callSid: this.callSid, error: error.message });
      const oldState = this.isSpeaking;
      this.isSpeaking = false;
      
      this.logStateTransition(this.callState, 'LISTENING', 'TTS synthesis error, returning to listening state');
      
      // Restart KeepAlive when returning to listening state after TTS error
      this._startKeepAlive();
      
      logger.debug('State change: isSpeaking', { 
        callSid: this.callSid, 
        from: oldState, 
        to: false, 
        reason: 'TTS Streaming Error', 
        responseId: this.currentResponseId,
        correlationId
      });
    }
  }

  /**
   * Streams μ-law audio directly to Twilio (for cached audio)
   */
  streamMulawToTwilio(mulawBuffer, correlationId, startTime) {
    const chunkSize = 1024; // Send in 1KB chunks
    let offset = 0;
    let chunkCount = 0;
    
    const sendNextChunk = () => {
      if (!this.isSpeaking || this.isUserSpeaking || offset >= mulawBuffer.length) {
        // Done sending or interrupted
        const audioEndTime = Date.now();
        this.lastAgentUtteranceEndTime = audioEndTime;
        
        this.logAudioEvent('CACHED_AUDIO_PLAYBACK_COMPLETED', {
          totalDeliveryTimeMs: audioEndTime - startTime,
          chunksDelivered: chunkCount,
          bytesDelivered: offset,
          correlationId
        });
        
        this.isSpeaking = false;
        this.logStateTransition(this.callState, 'LISTENING', 'Cached audio playback completed');
        
        // Restart KeepAlive when returning to listening state after cached audio
        this._startKeepAlive();
        
        return;
      }
      
      const chunk = mulawBuffer.slice(offset, offset + chunkSize);
      offset += chunk.length;
      chunkCount++;
      
      // Track first audio chunk timing for cached audio
      if (chunkCount === 1) {
        const endToEndTime = Date.now() - startTime;
        performanceMonitor.stageStart(this.callSid, 'first-audio-chunk');
        performanceMonitor.stageComplete(this.callSid, 'first-audio-chunk', {
          endToEndTimeMs: endToEndTime,
          fromCache: true
        });
        
        logger.info('First cached audio chunk sent to caller', {
          callSid: this.callSid,
          correlationId,
          endToEndTimeMs: endToEndTime
        });
      }
      
      if (this.twilioWs?.readyState === WebSocket.OPEN) {
        this.twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: chunk.toString('base64') }
        }));
      }
      
      // Send next chunk after a small delay to simulate real-time streaming
      setTimeout(sendNextChunk, 20); // ~50 chunks per second
    };
    
    sendNextChunk();
  }

  /**
   * Stops the current TTS playback for barge-in.
   */
  stopSpeaking() {
    if (!this.isSpeaking) return;
    
    const stopTime = Date.now();
    const oldState = this.isSpeaking;
    this.isSpeaking = false;
    this.lastAgentUtteranceEndTime = stopTime;
    
    const correlationId = this.logStateTransition(this.callState, 'LISTENING', 'Barge-in: Agent speech stopped', {
      interruptedUtterance: this.lastAgentUtterance,
      speechDurationMs: this.lastAgentUtteranceStartTime ? stopTime - this.lastAgentUtteranceStartTime : null
    });
    
    // Restart KeepAlive when returning to listening state after barge-in
    this._startKeepAlive();
    
    this.logAudioEvent('AUDIO_PLAYBACK_STOPPED_BARGE_IN', {
      reason: 'User barge-in',
      speechDurationMs: this.lastAgentUtteranceStartTime ? stopTime - this.lastAgentUtteranceStartTime : null,
      correlationId
    });

    logger.debug('State change: isSpeaking', { 
      callSid: this.callSid, 
      from: oldState, 
      to: false, 
      reason: 'Barge-in', 
      responseId: this.currentResponseId,
      correlationId
    });

    this.currentResponseId = null; // Clear current response
    
    // Clear any pending speech timers
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }
    
    if (this.twilioWs?.readyState === WebSocket.OPEN) {
      this.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
      logger.debug('TTS playback cleared for barge-in', { 
        callSid: this.callSid,
        responseId: this.currentResponseId,
        correlationId
      });
    }
  }

  stopFfmpeg() {
    if (this.ffmpegCommand) {
      logger.debug('Stopping FFmpeg process', { callSid: this.callSid });
      this.ffmpegCommand.kill('SIGKILL');
      this.ffmpegCommand = null;
    }
  }
  
  /**
   * Stop all streaming processes for barge-in
   */
  stopStreaming() {
    // This will be handled by the streaming pipeline checking isUserSpeaking flag
    logger.info('Stopping all streaming processes', { 
      callSid: this.callSid,
      wasStreaming: this.isSpeaking
    });
    
    // The streaming pipeline will detect the flag change and clean up
    this.isUserSpeaking = true;
    this.stopSpeaking();
  }

  /**
   * Plays a final message and then cleans up the call.
   */
  async handleHangup(finalMessage) {
    this.logStateTransition(this.callState, 'HANGING_UP', 'Playing final message before hangup', {
      finalMessage
    });
    
    if (finalMessage) {
      await this.streamToTTS(finalMessage);
    }
    setTimeout(() => this.cleanup(), 1000);
  }

  /**
   * Closes all connections and emits an event to signal the call has ended.
   */
  cleanup() {
    logger.info('Closing all connections', { 
      callSid: this.callSid,
      finalState: this.callState,
      pendingInputs: this.pendingUserInputs.length
    });
    
    this.logStateTransition(this.callState, 'TERMINATED', 'Cleanup initiated');
    
    // Stop KeepAlive timer
    this._stopKeepAlive();
    
    // Clear any pending timers
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }
    if (this.finalTranscriptTimer) {
      clearTimeout(this.finalTranscriptTimer);
      this.finalTranscriptTimer = null;
    }
    
    // Release connections back to pool if using pooling
    if (featureFlags.ENABLE_WEBSOCKET_POOLING) {
      if (this.deepgramWs) {
        connectionPool.releaseConnection(this.deepgramWs, 'deepgram');
      }
    } else {
      // Close on-demand connections
      if (this.deepgramWs) {
        this.deepgramWs.close();
        logger.info('Closed on-demand Deepgram connection', { 
          callSid: this.callSid,
          strategy: 'on-demand'
        });
      }
    }
    
    this.twilioWs?.close();
    
    // Log final conversation cycle summary
    if (this.cycleTracker) {
      this.cycleTracker.logFinalSummary();
    }
    
    // Complete performance monitoring session
    performanceMonitor.completeSession(this.callSid);
    
    // Generate comprehensive latency report periodically (10% of calls)
    if (Math.random() < 0.1) {
      performanceMonitor.logLatencyReport();
    }
    
    this.emit('call_ended');
  }
}

module.exports = { WebSocketOrchestrator };
