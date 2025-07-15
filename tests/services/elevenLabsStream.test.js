const { EventEmitter } = require('events');
const WebSocket = require('ws');

// Mock dependencies
jest.mock('../../src/utils/logger');
jest.mock('ws');

describe('ElevenLabsStreamService', () => {
  let ElevenLabsStreamService;
  let service;
  let mockLogger;
  let mockWs;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    
    // Create mock WebSocket
    mockWs = new EventEmitter();
    mockWs.send = jest.fn();
    mockWs.close = jest.fn();
    mockWs.readyState = WebSocket.OPEN;
    
    // Mock WebSocket constructor
    WebSocket.mockImplementation(() => mockWs);

    // Set environment variables
    process.env.ELEVENLABS_API_KEY = 'test-api-key';
    process.env.ELEVENLABS_VOICE_ID = 'test-voice-id';

    // Require after mocks are set up
    ElevenLabsStreamService = require('../../src/services/elevenLabsStream');
  });

  afterEach(() => {
    if (service) {
      service.disconnect();
    }
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      service = new ElevenLabsStreamService();
      
      expect(service.voiceId).toBe('test-voice-id');
      expect(service.model).toBe('eleven_turbo_v2_5');
      expect(service.connected).toBe(false);
      expect(service.ws).toBeNull();
    });

    it('should accept custom options', () => {
      service = new ElevenLabsStreamService({
        voiceId: 'custom-voice',
        model: 'eleven_multilingual_v2'
      });
      
      expect(service.voiceId).toBe('custom-voice');
      expect(service.model).toBe('eleven_multilingual_v2');
    });
  });

  describe('connect', () => {
    it('should establish WebSocket connection successfully', async () => {
      service = new ElevenLabsStreamService();
      
      const connectPromise = service.connect();
      
      // Simulate successful connection
      mockWs.emit('open');
      
      await connectPromise;
      
      expect(service.connected).toBe(true);
      expect(WebSocket).toHaveBeenCalledWith(
        expect.stringContaining('wss://api.elevenlabs.io/v1/text-to-speech/test-voice-id/stream-input')
      );
    });

    it('should handle connection errors', async () => {
      service = new ElevenLabsStreamService();
      
      const connectPromise = service.connect();
      
      // Simulate connection error
      mockWs.emit('error', new Error('Connection failed'));
      
      await expect(connectPromise).rejects.toThrow('Connection failed');
      expect(service.connected).toBe(false);
    });

    it('should not connect if already connected', async () => {
      service = new ElevenLabsStreamService();
      service.connected = true;
      service.ws = mockWs;
      
      await service.connect();
      
      expect(WebSocket).not.toHaveBeenCalled();
    });
  });

  describe('streamText', () => {
    beforeEach(async () => {
      service = new ElevenLabsStreamService();
      const connectPromise = service.connect();
      mockWs.emit('open');
      await connectPromise;
    });

    it('should send text message when connected', async () => {
      await service.streamText('Hello world');
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          text: 'Hello world',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0,
            use_speaker_boost: true
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290]
          }
        })
      );
    });

    it('should handle WebSocket not ready error', async () => {
      mockWs.readyState = WebSocket.CONNECTING;
      
      await expect(service.streamText('Hello')).rejects.toThrow('WebSocket is not ready');
    });

    it('should throw error when not connected', async () => {
      service.connected = false;
      
      await expect(service.streamText('Hello')).rejects.toThrow('Not connected to ElevenLabs');
    });
  });

  describe('flush', () => {
    beforeEach(async () => {
      service = new ElevenLabsStreamService();
      const connectPromise = service.connect();
      mockWs.emit('open');
      await connectPromise;
    });

    it('should send flush message when connected', async () => {
      await service.flush();
      
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ text: '' })
      );
    });
  });

  describe('audio stream handling', () => {
    beforeEach(async () => {
      service = new ElevenLabsStreamService();
      const connectPromise = service.connect();
      mockWs.emit('open');
      await connectPromise;
    });

    it('should emit audio events for audio chunks', (done) => {
      const audioData = Buffer.from('test-audio-data');
      
      service.on('audio', (data) => {
        expect(data).toEqual(audioData);
        done();
      });
      
      mockWs.emit('message', audioData);
    });

    it('should handle metadata messages', () => {
      const metadata = {
        type: 'metadata',
        audio_metadata: { sample_rate: 22050 }
      };
      
      mockWs.emit('message', JSON.stringify(metadata));
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[ElevenLabs] Received metadata',
        metadata.audio_metadata
      );
    });

    it('should emit end event on flush acknowledgment', (done) => {
      service.on('end', () => {
        done();
      });
      
      mockWs.emit('message', JSON.stringify({ type: 'flush' }));
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket connection', async () => {
      service = new ElevenLabsStreamService();
      const connectPromise = service.connect();
      mockWs.emit('open');
      await connectPromise;
      
      service.disconnect();
      
      expect(mockWs.close).toHaveBeenCalled();
      expect(service.connected).toBe(false);
      expect(service.ws).toBeNull();
    });

    it('should handle disconnect when not connected', () => {
      service = new ElevenLabsStreamService();
      
      expect(() => service.disconnect()).not.toThrow();
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      service = new ElevenLabsStreamService();
      const connectPromise = service.connect();
      mockWs.emit('open');
      await connectPromise;
    });

    it('should handle WebSocket errors', (done) => {
      service.on('error', (error) => {
        expect(error.message).toBe('WebSocket error');
        done();
      });
      
      mockWs.emit('error', new Error('WebSocket error'));
    });

    it('should handle unexpected disconnection', () => {
      mockWs.emit('close', 1000, 'Normal closure');
      
      expect(service.connected).toBe(false);
      expect(service.ws).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[ElevenLabs] WebSocket closed',
        expect.objectContaining({ code: 1000 })
      );
    });

    it('should handle message parsing errors', () => {
      mockWs.emit('message', 'invalid-json');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[ElevenLabs] Error processing message',
        expect.any(Object)
      );
    });
  });
});