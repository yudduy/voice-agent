/**
 * WebSocket Orchestrator for Real-time Voice Pipeline
 * Manages the entire real-time conversation flow.
 */

const WebSocket = require('ws');
const logger = require('../utils/logger');
const { EventEmitter } = require('events');
const conversationService = require('./conversation');
const userRepository = require('../repositories/userRepository');
const { Readable, PassThrough } = require('stream'); // Import Readable and PassThrough streams
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
const axios = require('axios');
const aiConfig = require('../config/ai');
const { createElevenLabsStream } = require('./elevenLabsStream');


class WebSocketOrchestrator extends EventEmitter {
  constructor(callSid, initialUserId) {
    super();
    this.callSid = callSid;
    // The userId is now passed in the 'start' message, so we initialize it as null.
    this.userId = initialUserId; 
    
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
    
    // DEBUG: Enhanced state tracking for investigation
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
    this.ffmpegCommand = null;
    
    // Feature flags
    this.USE_STREAMING_PIPELINE = process.env.ENABLE_SPECULATIVE_TTS === 'true';
    
    // DEBUG: Log orchestrator initialization
    logger.info('🎬 [DEBUG] WebSocketOrchestrator initialized', {
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
   * DEBUG: Log state transitions with detailed context
   */
  logStateTransition(fromState, toState, reason, additionalContext = {}) {
    const correlationId = ++this.correlationId;
    logger.info('🔄 [DEBUG-STATE] Call state transition', {
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
   * DEBUG: Log audio delivery events with precise timing
   */
  logAudioEvent(eventType, details = {}) {
    logger.info('🔊 [DEBUG-AUDIO] Audio delivery event', {
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
   * DEBUG: Log transcript processing with timing analysis
   */
  logTranscriptEvent(eventType, transcript, details = {}) {
    logger.info('🎙️ [DEBUG-TRANSCRIPT] Transcript processing', {
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
    logger.info('🎙️ [WebSocket] Twilio Media Stream connected', { callSid: this.callSid });

    // The Deepgram connection will be initiated *after* the greeting is played.
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'connected':
            logger.info(`📞 [Twilio] Media Stream ready for SID: ${data.streamSid}`, { callSid: this.callSid });
            break;
            
          case 'start':
            this.streamSid = data.start.streamSid;
            this.userId = data.start.customParameters.userId;
            logger.info(`🎬 [Twilio] Stream started. UserId: ${this.userId}`, { callSid: this.callSid });
            
            this.logStateTransition('IDLE', 'INITIALIZING', 'Twilio stream started');
            
            await this.playGreeting();
            await this.connectToDeepgram();
            break;
            
          case 'media':
            // CRITICAL FIX: Decode the Base64 payload from Twilio before sending to Deepgram.
            // Deepgram expects raw binary audio, not a Base64 string.
            if (this.deepgramWs?.readyState === WebSocket.OPEN) {
              const audioBuffer = Buffer.from(data.media.payload, 'base64');
              this.deepgramWs.send(audioBuffer);
              
              // DEBUG: Log audio data flow (sampled to avoid spam)
              if (Math.random() < 0.01) { // Log 1% of audio packets
                logger.debug('📡 [DEBUG-AUDIO-FLOW] Twilio → Deepgram audio packet', {
                  callSid: this.callSid,
                  timestamp: new Date().toISOString(),
                  payloadSize: audioBuffer.length,
                  callState: this.callState
                });
              }
            }
            break;
            
          case 'stop':
            logger.info('🛑 [Twilio] Stream stopped', { callSid: this.callSid });
            this.logStateTransition(this.callState, 'TERMINATED', 'Twilio stream stopped');
            this.cleanup();
            break;
        }
      } catch (error) {
        logger.error('❌ [Twilio] Message processing error', { callSid: this.callSid, error: error.message });
      }
    });

    ws.on('close', () => {
      logger.info('🔌 [Twilio] WebSocket closed', { callSid: this.callSid });
      this.logStateTransition(this.callState, 'DISCONNECTED', 'Twilio WebSocket closed');
      this.cleanup();
    });

    ws.on('error', (error) => {
      logger.error('❌ [Twilio] WebSocket error', { callSid: this.callSid, error: error.message });
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
      
      logger.info('🎤 [Greeting] Playing Ben/Microsoft Support identification greeting', { callSid: this.callSid, text: greetingText });
      await this.streamToTTS(greetingText);
    } catch (error) {
      logger.error('❌ [Greeting] Failed to play greeting, using default.', { callSid: this.callSid, error: error.message });
      await this.streamToTTS(greetingText);
    }
  }

  /**
   * Connects to Deepgram for real-time transcription.
   */
  async connectToDeepgram() {
    const deepgramUrl = new URL('wss://api.deepgram.com/v1/listen');
    deepgramUrl.searchParams.set('encoding', 'mulaw');
    deepgramUrl.searchParams.set('sample_rate', '8000');
    deepgramUrl.searchParams.set('model', 'nova-2');
    deepgramUrl.searchParams.set('interim_results', 'true');
    deepgramUrl.searchParams.set('endpointing', '450'); // Increased from 300ms
    deepgramUrl.searchParams.set('vad_events', 'true');
    deepgramUrl.searchParams.set('utterance_end_ms', '1000'); // Use UtteranceEnd for robust end-of-speech

    logger.info('🎤 [DEBUG] Deepgram connection configuration', {
      callSid: this.callSid,
      config: {
        encoding: 'mulaw',
        sampleRate: '8000',
        model: 'nova-2',
        endpointing: '450',
        utteranceEndMs: '1000',
        vadEvents: true,
        interimResults: true
      }
    });

    this.deepgramWs = new WebSocket(deepgramUrl.toString(), {
      headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    this.deepgramWs.on('open', () => {
      logger.info('🎤 [Deepgram] Connected to streaming STT', { callSid: this.callSid });
      this.logStateTransition(this.callState, 'LISTENING', 'Deepgram connected and ready');
    });
    
    this.deepgramWs.on('close', () => {
      logger.info('🔌 [Deepgram] WebSocket closed', { callSid: this.callSid });
    });
    
    this.deepgramWs.on('error', (error) => {
      logger.error('❌ [Deepgram] WebSocket error', { callSid: this.callSid, error: error.message });
    });
    
    this.deepgramWs.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        const timestamp = Date.now();
        
        // DEBUG: Log all Deepgram events for investigation
        if (message.type !== 'Results' || message.channel?.alternatives?.[0]?.transcript) {
          logger.debug('🎤 [DEBUG-DEEPGRAM] Raw event received', {
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
              logger.debug('⏰ [DEBUG] Cleared speech end timer due to final transcript', {
                callSid: this.callSid,
                transcript
              });
            }
            this.lastProcessedTranscript = transcript; // Store the latest final transcript
          }
        }
        
        // Handle UtteranceEnd for robust turn-taking
        if (message.type === 'UtteranceEnd') {
          this.logTranscriptEvent('UTTERANCE_END', this.lastProcessedTranscript, {
            vadEvent: true,
            hasStoredTranscript: !!this.lastProcessedTranscript
          });
          
          logger.info('🔚 [Deepgram] UtteranceEnd detected.', { callSid: this.callSid });
          if (this.speechEndTimer) {
            clearTimeout(this.speechEndTimer);
            this.speechEndTimer = null;
          }
          // Process the last known final transcript
          if (this.lastProcessedTranscript) {
            await this.handleFinalTranscript(this.lastProcessedTranscript);
          }
        }

      } catch (error) {
      logger.error('❌ [Deepgram] Message processing error', { callSid: this.callSid, error: error.message });
      }
    });
  }

  /**
   * Handles when user starts speaking
   */
  handleSpeechStarted() {
    const now = Date.now();
    
    // Skip if in barge-in cooldown
    if (this.isBargeInCooldown) {
      logger.info('🔇 [Speech] Ignoring speech start - in barge-in cooldown', { callSid: this.callSid });
      return;
    }

    // Implement barge-in: stop current TTS if agent is speaking
    if (this.isSpeaking) {
      // Check if we're within the grace period after starting to speak
      const timeSinceSpeechStart = now - this.audioDeliveryMetrics.startTime;
      if (timeSinceSpeechStart < this.BARGE_IN_GRACE_PERIOD_MS) {
        logger.info('🕐 [Speech] Ignoring speech start - within grace period', { 
          callSid: this.callSid,
          timeSinceSpeechStart,
          gracePeriod: this.BARGE_IN_GRACE_PERIOD_MS
        });
        return;
      }

      const correlationId = this.logStateTransition(this.callState, 'BARGE_IN_DETECTED', 'User interrupted agent speech');
      
      logger.info('🛑 [Barge-in] User interrupted - stopping agent speech and starting cooldown', {
        callSid: this.callSid,
        correlationId,
        agentWasSpeaking: this.lastSpokenText,
        timeSinceAgentStarted: timeSinceSpeechStart
      });

      this.stopFfmpeg();
      this.stopStreaming(); // Stop streaming pipeline if active
      this.stopSpeaking();
      
      // Start a cooldown period to prevent immediate re-triggering
      this.isBargeInCooldown = true;
      setTimeout(() => {
        this.isBargeInCooldown = false;
        logger.info('✅ [Barge-in] Cooldown period ended', { callSid: this.callSid });
      }, this.BARGE_IN_COOLDOWN);
    }

    // Reset speech end timer
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }

    this.logStateTransition(this.callState, 'USER_SPEAKING', 'User started speaking');
  }

  /**
   * Handles final transcript with proper turn management
   */
  async handleFinalTranscript(transcript) {
    const processingStart = Date.now();
    const timeSinceLastInput = processingStart - this.lastUserInputTime;
    
    this.logTranscriptEvent('PROCESSING_FINAL_TRANSCRIPT', transcript, {
      processingStartTime: processingStart,
      timeSinceLastInput,
      isDuplicate: transcript === this.lastProcessedTranscript && timeSinceLastInput < 2000,
      isShort: transcript.length < 3,
      systemBusy: this.isSpeaking || this.processingLLM
    });
    
    // Prevent duplicate processing
    if (transcript === this.lastProcessedTranscript && (timeSinceLastInput < 2000)) {
      logger.debug('🔄 [Turn-taking] Ignoring duplicate transcript', { 
        callSid: this.callSid, 
        transcript,
        timeSinceLastInput
      });
      return;
    }

    // Ignore very short, likely noise-based transcripts
    if (transcript.length < 3) {
      this.logTranscriptEvent('TRANSCRIPT_FILTERED_SHORT', transcript, {
        reason: 'Transcript too short, likely noise'
      });
      logger.debug('🔇 [Turn-taking] Ignoring very short transcript (likely noise)', {
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
      logger.debug('⏱️ [Turn-taking] Too soon after last input, ignoring', { 
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
      
      logger.info('🤐 [Turn-taking] Agent busy, saving transcript for later', { 
        callSid: this.callSid,
        isSpeaking: this.isSpeaking,
        processingLLM: this.processingLLM,
        transcript
      });
      
      // Add to pending queue for later processing
      this.pendingUserInputs.push({
        transcript,
        timestamp: processingStart,
        callState: this.callState
      });
      return;
    }

    // Process the transcript
    this.lastProcessedTranscript = transcript;
    this.lastUserInputTime = processingStart;
    
    this.logTranscriptEvent('TRANSCRIPT_ACCEPTED_FOR_LLM', transcript, {
      processingDecision: 'ACCEPT',
      queuedForLLM: true
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
        logger.warn('⚠️ [PATTERN] Repetitive scam pattern detected', {
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
            logger.warn('⚠️ [PATTERN] Repetitive confusion loop detected', {
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
        logger.warn('🚫 [LLM] Attempted to process while another process was running.', {
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
    
    logger.info(`🧠 [LLM-INPUT] User said: "${userInput}"`, { 
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
        logger.info('🚀 [STREAMING] Using speculative TTS pipeline', {
          callSid: this.callSid,
          correlationId
        });
        // Use streaming pipeline for real-time response
        await this.streamLLMToTTS(userInput, correlationId, llmStartTime);
      } else {
        // Use legacy pipeline
        const response = await conversationService.getResponse(userInput, this.callSid, this.userId);
        const llmEndTime = Date.now();
        const llmProcessingTime = llmEndTime - llmStartTime;
        
        logger.info(`🧠 [LLM-OUTPUT] AI response: "${response.text}"`, { 
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
          logger.info('🔄 [PATTERN] Breaking repetitive loop with clarification', {
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
      logger.error('❌ [LLM] Processing error', { 
        callSid: this.callSid, 
        error: error.message, 
        responseId: this.currentResponseId,
        correlationId,
        processingTimeMs: Date.now() - llmStartTime
      });
      await this.streamToTTS("Ugh, sorry! I'm having some technical issues right now. This is so frustrating!");
    } finally {
      const finalTime = Date.now();
      logger.info('🏁 [LLM] Processing finished.', { 
        callSid: this.callSid, 
        responseId: this.currentResponseId,
        correlationId,
        totalProcessingTimeMs: finalTime - llmStartTime
      });
      this.processingLLM = false;
      
      // Process any pending user inputs
      if (this.pendingUserInputs.length > 0) {
        logger.info('📥 [Turn-taking] Processing pending user inputs', {
          callSid: this.callSid,
          pendingCount: this.pendingUserInputs.length
        });
        
        const nextInput = this.pendingUserInputs.shift();
        if (nextInput && !this.isSpeaking) {
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
    
    logger.info('🚀 [STREAMING] Starting real-time LLM → TTS pipeline', {
      callSid: this.callSid,
      streamId,
      correlationId,
      userInput: userInput.slice(0, 50)
    });

    let elevenLabsStream = null;
    let ffmpegProcess = null;
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
      elevenLabsStream = createElevenLabsStream();
      await elevenLabsStream.connect();
      
      // Set up FFmpeg for real-time transcoding
      const ffmpegInputStream = new PassThrough();
      
      ffmpegProcess = ffmpeg(ffmpegInputStream)
        .inputFormat('mp3')
        .audioCodec('pcm_mulaw')
        .audioFrequency(8000)
        .toFormat('mulaw')
        .on('error', (err) => {
          if (!err.message.includes('SIGKILL')) {
            logger.error('❌ [STREAMING] FFmpeg error', {
              streamId,
              error: err.message
            });
          }
        });
      
      const ffmpegOutputStream = ffmpegProcess.pipe();
      
      // Handle audio from ElevenLabs → FFmpeg → Twilio
      elevenLabsStream.on('audio', (audioBuffer) => {
        if (!this.isSpeaking || this.isUserSpeaking) {
          logger.debug('🛑 [STREAMING] Dropping audio chunk due to interruption', { streamId });
          return;
        }
        
        // Write to FFmpeg for transcoding
        ffmpegInputStream.write(audioBuffer);
      });
      
      // Handle transcoded audio from FFmpeg → Twilio
      ffmpegOutputStream.on('data', (chunk) => {
        if (!this.isSpeaking || this.isUserSpeaking) {
          return;
        }
        
        audioChunksSent++;
        
        if (this.twilioWs?.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: chunk.toString('base64') }
          }));
          
          if (audioChunksSent % 10 === 0) {
            logger.debug('🔊 [STREAMING] Audio progress', {
              streamId,
              audioChunksSent,
              textLength: fullResponseText.length
            });
          }
        }
      });
      
      // Get LLM response stream
      const llmStream = conversationService.getResponseStream(userInput, this.callSid, this.userId);
      
      // Process LLM chunks and send to TTS
      for await (const textChunk of llmStream) {
        // Check for interruption
        if (this.isUserSpeaking) {
          logger.info('🛑 [STREAMING] User interrupted, stopping pipeline', {
            streamId,
            textGenerated: fullResponseText.length
          });
          break;
        }
        
        // Skip special markers
        if (textChunk === '\n[CORRECTION]\n') {
          logger.warn('⚠️ [STREAMING] Correction marker detected', { streamId });
          fullResponseText = ''; // Reset for corrected version
          continue;
        }
        
        chunksReceived++;
        fullResponseText += textChunk;
        
        // Send to ElevenLabs
        elevenLabsStream.sendText(textChunk);
        
        // Update last utterance for debugging
        this.lastAgentUtterance = fullResponseText;
        
        // Log progress
        if (chunksReceived % 5 === 0) {
          logger.debug('📝 [STREAMING] Text generation progress', {
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
      
      // Get metadata if available
      if (llmStream.metadata) {
        fullResponseText = llmStream.metadata.fullResponse || fullResponseText;
        shouldHangup = llmStream.metadata.shouldHangup || false;
      }
      
      const endTime = Date.now();
      
      logger.info('✅ [STREAMING] Pipeline completed', {
        callSid: this.callSid,
        streamId,
        correlationId,
        totalTimeMs: endTime - startTime,
        responseLength: fullResponseText.length,
        textChunks: chunksReceived,
        audioChunks: audioChunksSent,
        shouldHangup
      });
      
      // Store complete utterance
      this.lastAgentUtterance = fullResponseText;
      this.lastAgentUtteranceEndTime = endTime;
      
      // Check for patterns and hangup
      const isRepetitive = this.detectRepetitivePattern(userInput, fullResponseText);
      
      if (isRepetitive && this.identificationAttempts > 2) {
        const breakLoopResponse = "I understand there may be some confusion. This is Ben from Microsoft Support regarding a critical security issue on your computer. If you're not interested in protecting your data, I'll end this call.";
        logger.info('🔄 [STREAMING] Breaking repetitive loop', {
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
      logger.error('❌ [STREAMING] Pipeline error', {
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
        elevenLabsStream.close();
      }
      
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGKILL');
      }
      
      this.isSpeaking = false;
      this.processingLLM = false;
      
      logger.info('🧹 [STREAMING] Cleanup completed', {
        streamId,
        finalResponseLength: fullResponseText.length
      });
    }
  }

  /**
   * Downloads audio from ElevenLabs, then transcodes and streams it to Twilio.
   * (Legacy method - kept for fallback and non-streaming scenarios)
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
    
    logger.info('🗣️ [State Change] isSpeaking', { 
      callSid: this.callSid, 
      from: oldState, 
      to: true, 
      responseId: this.currentResponseId,
      correlationId,
      agentText: text
    });
    
    try {
      const elevenLabsStartTime = Date.now();
      
      const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${aiConfig.elevenLabs.voiceId}`,
        headers: { 'Accept': 'audio/mpeg', 'xi-api-key': aiConfig.elevenLabs.apiKey, 'Content-Type': 'application/json' },
        data: { text: text, model_id: 'eleven_turbo_v2' },
        responseType: 'arraybuffer'
      });

      const elevenLabsEndTime = Date.now();
      const synthesisTime = elevenLabsEndTime - elevenLabsStartTime;

      if (response.status !== 200 || !response.data || response.data.length === 0) {
        throw new Error(`ElevenLabs API returned status ${response.status} or empty audio.`);
      }

      this.logAudioEvent('TTS_SYNTHESIS_COMPLETED', {
        synthesisTimeMs: synthesisTime,
        audioSizeBytes: response.data.length,
        correlationId
      });

      const audioBuffer = Buffer.from(response.data);
      const readable = Readable.from(audioBuffer);

      const transcodingStartTime = Date.now();
      
      this.ffmpegCommand = ffmpeg(readable)
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
            logger.info('🔪 [FFMPEG] Process killed intentionally for barge-in', { callSid: this.callSid });
            return;
        }
        logger.error('❌ [FFMPEG] Error during transcoding', { 
            callSid: this.callSid, 
            error: err.message,
            stdout,
            stderr
        });
        this.stopSpeaking();
      });

      this.ffmpegCommand.on('end', () => {
        logger.info('🏁 [FFMPEG] Transcoding finished', { callSid: this.callSid, responseId: this.currentResponseId });
        this.stopSpeaking();
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

      transcodedStream.on('data', (chunk) => {
        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          this.logAudioEvent('FIRST_AUDIO_CHUNK_SENT', {
            transcodingTimeMs: firstChunkTime - transcodingStartTime,
            chunkSize: chunk.length,
            correlationId
          });
        }
        
        chunkCount++;
        totalBytes += chunk.length;
        
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

      transcodedStream.on('end', () => {
        const audioEndTime = Date.now();
        this.lastAgentUtteranceEndTime = audioEndTime;
        
        this.logAudioEvent('AUDIO_PLAYBACK_COMPLETED', {
          totalDeliveryTimeMs: audioEndTime - ttsStartTime,
          transcodingTimeMs: firstChunkTime ? firstChunkTime - transcodingStartTime : null,
          chunksDelivered: chunkCount,
          bytesDelivered: totalBytes,
          correlationId
        });
        
        logger.debug('🔊 [TTS] Audio playback transcoding completed', { callSid: this.callSid });
        const oldState = this.isSpeaking;
        this.isSpeaking = false;
        
        this.logStateTransition(this.callState, 'LISTENING', 'Audio playback completed, ready for user input');
        
        logger.info('🗣️ [State Change] isSpeaking', { 
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
        
        logger.error('❌ [TTS] Transcoding pipeline error', { callSid: this.callSid, error: err.message });
        const oldState = this.isSpeaking;
        this.isSpeaking = false;
        this.lastAgentUtteranceEndTime = errorTime;
        
        this.logStateTransition(this.callState, 'LISTENING', 'Audio transcoding error, returning to listening state');
        
        logger.info('🗣️ [State Change] isSpeaking', { 
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
      
      logger.error('❌ [TTS] Streaming error', { callSid: this.callSid, error: error.message });
      const oldState = this.isSpeaking;
      this.isSpeaking = false;
      
      this.logStateTransition(this.callState, 'LISTENING', 'TTS synthesis error, returning to listening state');
      
      logger.info('🗣️ [State Change] isSpeaking', { 
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
    
    this.logAudioEvent('AUDIO_PLAYBACK_STOPPED_BARGE_IN', {
      reason: 'User barge-in',
      speechDurationMs: this.lastAgentUtteranceStartTime ? stopTime - this.lastAgentUtteranceStartTime : null,
      correlationId
    });

    logger.info('🗣️ [State Change] isSpeaking', { 
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
      logger.info('🔊 [TTS] Playback cleared for barge-in', { 
        callSid: this.callSid,
        responseId: this.currentResponseId,
        correlationId
      });
    }
  }

  stopFfmpeg() {
    if (this.ffmpegCommand) {
      logger.info('🔪 [FFMPEG] Attempting to kill FFMPEG process', { callSid: this.callSid });
      this.ffmpegCommand.kill('SIGKILL');
      this.ffmpegCommand = null;
    }
  }
  
  /**
   * Stop all streaming processes for barge-in
   */
  stopStreaming() {
    // This will be handled by the streaming pipeline checking isUserSpeaking flag
    logger.info('🛑 [STREAMING] Stopping all streaming processes', { 
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
    logger.info('🧹 [Cleanup] Closing all connections', { 
      callSid: this.callSid,
      finalState: this.callState,
      pendingInputs: this.pendingUserInputs.length
    });
    
    this.logStateTransition(this.callState, 'TERMINATED', 'Cleanup initiated');
    
    this.deepgramWs?.close();
    this.twilioWs?.close();
    this.emit('call_ended');
  }
}

module.exports = { WebSocketOrchestrator };
