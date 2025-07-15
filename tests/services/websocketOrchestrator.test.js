const WebSocket = require('ws');
const { EventEmitter } = require('events');

// Mock dependencies
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/conversation');
jest.mock('../../src/services/textToSpeech');
jest.mock('../../src/services/cacheService');
jest.mock('../../src/config/featureFlags', () => ({
  featureFlags: {
    ENABLE_SPECULATIVE_TTS: false,
    ENABLE_WEBSOCKET_POOLING: false
  }
}));

describe('WebsocketOrchestrator', () => {
  let WebsocketOrchestrator;
  let orchestrator;
  let mockWs;
  let mockLogger;
  let mockConversationService;
  let mockTextToSpeech;
  let mockCacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create mock WebSocket
    mockWs = new EventEmitter();
    mockWs.send = jest.fn();
    mockWs.close = jest.fn();
    mockWs.readyState = WebSocket.OPEN;

    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    mockConversationService = require('../../src/services/conversation');
    mockTextToSpeech = require('../../src/services/textToSpeech');
    mockCacheService = require('../../src/services/cacheService');

    // Setup default mock implementations
    mockConversationService.generateResponse = jest.fn().mockResolvedValue({
      response: 'Test response',
      intent: 'general'
    });
    
    mockTextToSpeech.generateSpeech = jest.fn().mockResolvedValue('/path/to/audio.wav');
    
    mockCacheService.saveCallMapping = jest.fn().mockResolvedValue();
    mockCacheService.removeCallMapping = jest.fn().mockResolvedValue();

    // Require after mocks are set up
    WebsocketOrchestrator = require('../../src/services/websocketOrchestrator');
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
      
      expect(orchestrator.ws).toBe(mockWs);
      expect(orchestrator.callSid).toBe('test-call-sid');
      expect(orchestrator.streamSid).toBe('test-stream-sid');
      expect(orchestrator.isSpeaking).toBe(false);
      expect(orchestrator.isUserSpeaking).toBe(false);
      expect(orchestrator.processingLLM).toBe(false);
    });
  });

  describe('start', () => {
    it('should save call mapping on start', async () => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
      await orchestrator.start();
      
      expect(mockCacheService.saveCallMapping).toHaveBeenCalledWith('test-call-sid', 'test-stream-sid');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket orchestrator started'),
        expect.objectContaining({ callSid: 'test-call-sid' })
      );
    });
  });

  describe('handleDeepgramTranscript', () => {
    beforeEach(() => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
    });

    it('should handle final transcript correctly', async () => {
      const transcript = {
        is_final: true,
        channel: {
          alternatives: [{
            transcript: 'Hello there'
          }]
        }
      };

      await orchestrator.handleDeepgramTranscript(transcript);

      expect(mockConversationService.generateResponse).toHaveBeenCalledWith(
        'test-call-sid',
        'Hello there',
        expect.any(Object)
      );
    });

    it('should ignore empty transcripts', async () => {
      const transcript = {
        is_final: true,
        channel: {
          alternatives: [{
            transcript: ''
          }]
        }
      };

      await orchestrator.handleDeepgramTranscript(transcript);

      expect(mockConversationService.generateResponse).not.toHaveBeenCalled();
    });

    it('should handle duplicate transcripts correctly', async () => {
      const transcript = {
        is_final: true,
        channel: {
          alternatives: [{
            transcript: 'Same message'
          }]
        }
      };

      // First call
      await orchestrator.handleDeepgramTranscript(transcript);
      expect(mockConversationService.generateResponse).toHaveBeenCalledTimes(1);

      // Duplicate call immediately after
      await orchestrator.handleDeepgramTranscript(transcript);
      expect(mockConversationService.generateResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop', () => {
    it('should clean up resources correctly', async () => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
      
      // Set up some state
      orchestrator.deepgramWs = new EventEmitter();
      orchestrator.deepgramWs.close = jest.fn();
      orchestrator.ttsProcess = { kill: jest.fn() };

      await orchestrator.stop();

      expect(orchestrator.deepgramWs.close).toHaveBeenCalled();
      expect(orchestrator.ttsProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockCacheService.removeCallMapping).toHaveBeenCalledWith('test-call-sid');
      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle WebSocket errors gracefully', () => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
      
      const error = new Error('WebSocket error');
      mockWs.emit('error', error);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket error'),
        expect.objectContaining({ error: error.message })
      );
    });

    it('should handle Deepgram connection errors', async () => {
      orchestrator = new WebsocketOrchestrator(mockWs, 'test-call-sid', 'test-stream-sid');
      
      // Mock WebSocket constructor to throw error
      const originalWebSocket = global.WebSocket;
      global.WebSocket = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      });

      await orchestrator.initializeDeepgram();

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialize Deepgram'),
        expect.any(Object)
      );

      // Restore original WebSocket
      global.WebSocket = originalWebSocket;
    });
  });
});