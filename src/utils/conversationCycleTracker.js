/**
 * Conversation Cycle Tracker
 * 
 * Tracks the latency of complete conversation cycles:
 * User Speech → STT → LLM → TTS → Audio Playback
 */

const logger = require('./logger');

class ConversationCycleTracker {
  constructor(callSid) {
    this.callSid = callSid;
    this.activeCycles = new Map();
    this.completedCycles = [];
    this.cycleCounter = 0;
  }

  /**
   * Start a new conversation cycle when user begins speaking
   */
  startCycle() {
    this.cycleCounter++;
    const cycleId = `cycle_${this.cycleCounter}`;
    
    const cycle = {
      id: cycleId,
      number: this.cycleCounter,
      timestamps: {
        cycleStart: Date.now(),
        userSpeechEnd: null,
        sttComplete: null,
        llmFirstToken: null,
        llmComplete: null,
        ttsFirstAudio: null,
        ttsComplete: null,
        firstAudioSent: null,
        cycleComplete: null
      },
      durations: {},
      metadata: {
        transcript: '',
        response: '',
        sttConfidence: null,
        responseLength: 0,
        audioChunks: 0
      }
    };
    
    this.activeCycles.set(cycleId, cycle);
    
    logger.info('🔄 Started conversation cycle', {
      callSid: this.callSid,
      cycleId,
      cycleNumber: this.cycleCounter,
      timestamp: new Date().toISOString()
    });
    
    return cycleId;
  }

  /**
   * Mark when user finishes speaking
   */
  markUserSpeechEnd(cycleId, transcript = '', confidence = null) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.userSpeechEnd = Date.now();
    cycle.metadata.transcript = transcript;
    cycle.metadata.sttConfidence = confidence;
    
    // Calculate user speech duration
    cycle.durations.userSpeech = cycle.timestamps.userSpeechEnd - cycle.timestamps.cycleStart;
    
    logger.debug('🎤 User speech ended', {
      callSid: this.callSid,
      cycleId,
      transcript: transcript.substring(0, 50),
      userSpeechDuration: cycle.durations.userSpeech,
      confidence
    });
  }

  /**
   * Mark when STT processing is complete
   */
  markSTTComplete(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.sttComplete = Date.now();
    cycle.durations.stt = cycle.timestamps.sttComplete - cycle.timestamps.userSpeechEnd;
    
    logger.debug('📝 STT processing complete', {
      callSid: this.callSid,
      cycleId,
      sttDuration: cycle.durations.stt
    });
  }

  /**
   * Mark when first LLM token is received
   */
  markLLMFirstToken(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.llmFirstToken = Date.now();
    cycle.durations.llmFirstToken = cycle.timestamps.llmFirstToken - cycle.timestamps.sttComplete;
    
    logger.debug('🧠 LLM first token received', {
      callSid: this.callSid,
      cycleId,
      llmFirstTokenDuration: cycle.durations.llmFirstToken
    });
  }

  /**
   * Mark when LLM processing is complete
   */
  markLLMComplete(cycleId, response = '') {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.llmComplete = Date.now();
    cycle.durations.llmTotal = cycle.timestamps.llmComplete - cycle.timestamps.sttComplete;
    cycle.metadata.response = response;
    cycle.metadata.responseLength = response.length;
    
    logger.debug('🧠 LLM processing complete', {
      callSid: this.callSid,
      cycleId,
      llmTotalDuration: cycle.durations.llmTotal,
      responseLength: cycle.metadata.responseLength
    });
  }

  /**
   * Mark when first TTS audio is received
   */
  markTTSFirstAudio(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.ttsFirstAudio = Date.now();
    cycle.durations.ttsFirstAudio = cycle.timestamps.ttsFirstAudio - cycle.timestamps.llmComplete;
    
    logger.debug('🔊 TTS first audio received', {
      callSid: this.callSid,
      cycleId,
      ttsFirstAudioDuration: cycle.durations.ttsFirstAudio
    });
  }

  /**
   * Mark when TTS processing is complete
   */
  markTTSComplete(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.ttsComplete = Date.now();
    cycle.durations.ttsTotal = cycle.timestamps.ttsComplete - cycle.timestamps.llmComplete;
    
    logger.debug('🔊 TTS processing complete', {
      callSid: this.callSid,
      cycleId,
      ttsTotalDuration: cycle.durations.ttsTotal
    });
  }

  /**
   * Mark when first audio chunk is sent to user
   */
  markFirstAudioSent(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.firstAudioSent = Date.now();
    cycle.durations.timeToFirstAudio = cycle.timestamps.firstAudioSent - cycle.timestamps.userSpeechEnd;
    
    logger.debug('📞 First audio sent to user', {
      callSid: this.callSid,
      cycleId,
      timeToFirstAudio: cycle.durations.timeToFirstAudio
    });
  }

  /**
   * Complete the conversation cycle
   */
  completeCycle(cycleId, audioChunks = 0) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) return;

    cycle.timestamps.cycleComplete = Date.now();
    cycle.durations.totalCycle = cycle.timestamps.cycleComplete - cycle.timestamps.cycleStart;
    cycle.metadata.audioChunks = audioChunks;
    
    // Calculate end-to-end latency (most important metric)
    cycle.durations.endToEndLatency = cycle.timestamps.firstAudioSent - cycle.timestamps.userSpeechEnd;
    
    // Move to completed cycles
    this.activeCycles.delete(cycleId);
    this.completedCycles.push(cycle);
    
    // Comprehensive cycle summary
    logger.info('✅ Conversation cycle completed', {
      callSid: this.callSid,
      cycleId,
      cycleNumber: cycle.number,
      summary: {
        endToEndLatency: cycle.durations.endToEndLatency,
        timeToFirstAudio: cycle.durations.timeToFirstAudio,
        totalCycleDuration: cycle.durations.totalCycle
      },
      breakdown: {
        userSpeech: cycle.durations.userSpeech,
        stt: cycle.durations.stt,
        llmFirstToken: cycle.durations.llmFirstToken,
        llmTotal: cycle.durations.llmTotal,
        ttsFirstAudio: cycle.durations.ttsFirstAudio,
        ttsTotal: cycle.durations.ttsTotal
      },
      metadata: {
        transcript: cycle.metadata.transcript.substring(0, 100),
        responsePreview: cycle.metadata.response.substring(0, 100),
        transcriptLength: cycle.metadata.transcript.length,
        responseLength: cycle.metadata.responseLength,
        audioChunks: cycle.metadata.audioChunks,
        sttConfidence: cycle.metadata.sttConfidence
      },
      performance: {
        status: this.getPerformanceStatus(cycle.durations.endToEndLatency),
        target: '<2000ms',
        efficiency: this.calculateEfficiency(cycle.durations)
      }
    });
    
    return cycle;
  }

  /**
   * Get performance status based on end-to-end latency
   */
  getPerformanceStatus(endToEndLatency) {
    if (endToEndLatency < 1500) return 'EXCELLENT';
    if (endToEndLatency < 2000) return 'GOOD';
    if (endToEndLatency < 3000) return 'ACCEPTABLE';
    return 'POOR';
  }

  /**
   * Calculate pipeline efficiency
   */
  calculateEfficiency(durations) {
    const processing = (durations.stt || 0) + (durations.llmTotal || 0) + (durations.ttsTotal || 0);
    const total = durations.endToEndLatency || 1;
    return Math.round((processing / total) * 100);
  }

  /**
   * Get current cycle ID if active
   */
  getCurrentCycleId() {
    const activeCycleIds = Array.from(this.activeCycles.keys());
    return activeCycleIds.length > 0 ? activeCycleIds[activeCycleIds.length - 1] : null;
  }

  /**
   * Get summary statistics for all completed cycles
   */
  getSummaryStats() {
    if (this.completedCycles.length === 0) {
      return { cycleCount: 0, averageLatency: 0, totalConversationTime: 0 };
    }

    const latencies = this.completedCycles.map(c => c.durations.endToEndLatency);
    const totalTime = this.completedCycles.reduce((sum, c) => sum + c.durations.totalCycle, 0);
    
    return {
      cycleCount: this.completedCycles.length,
      averageLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies),
      totalConversationTime: totalTime,
      averageCycleTime: Math.round(totalTime / this.completedCycles.length)
    };
  }

  /**
   * Log final conversation summary
   */
  logFinalSummary() {
    const stats = this.getSummaryStats();
    
    logger.info('📊 Final conversation cycle summary', {
      callSid: this.callSid,
      conversationSummary: stats,
      activeCycles: this.activeCycles.size,
      completedCycles: this.completedCycles.length
    });
    
    return stats;
  }
}

module.exports = ConversationCycleTracker;