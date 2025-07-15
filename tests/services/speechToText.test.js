const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Mock dependencies
jest.mock('axios');
jest.mock('fs').promises;
jest.mock('../../src/utils/logger');
jest.mock('../../src/utils/voiceMonitor');
jest.mock('groq-sdk');

describe('SpeechToText Service', () => {
  let speechToText;
  let mockLogger;
  let mockVoiceMonitor;
  let mockFs;
  let mockGroq;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    mockVoiceMonitor = require('../../src/utils/voiceMonitor');
    mockFs = require('fs').promises;
    
    // Mock Groq SDK
    const GroqSDK = require('groq-sdk');
    mockGroq = {
      audio: {
        transcriptions: {
          create: jest.fn()
        }
      }
    };
    GroqSDK.mockImplementation(() => mockGroq);
    
    // Default mock implementations
    mockFs.readFile = jest.fn().mockResolvedValue(Buffer.from('audio-data'));
    mockVoiceMonitor.recordSTTProcessing = jest.fn();

    // Set environment variables
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.SPEECH_RECOGNITION_PREFERENCE = 'groq';

    // Require after mocks are set up
    speechToText = require('../../src/services/speechToText');
  });

  describe('transcribeAudio', () => {
    const testAudioPath = '/path/to/audio.wav';
    const testTranscript = 'Hello world';

    it('should transcribe audio using Groq when preferred', async () => {
      mockGroq.audio.transcriptions.create.mockResolvedValue({
        text: testTranscript
      });

      const result = await speechToText.transcribeAudio(testAudioPath);

      expect(result).toBe(testTranscript);
      expect(mockGroq.audio.transcriptions.create).toHaveBeenCalledWith({
        file: expect.any(Buffer),
        model: 'whisper-large-v3',
        response_format: 'json',
        temperature: 0.0,
        language: 'en'
      });
      expect(mockVoiceMonitor.recordSTTProcessing).toHaveBeenCalled();
    });

    it('should handle Groq API errors', async () => {
      const error = new Error('Groq API error');
      error.status = 429;
      mockGroq.audio.transcriptions.create.mockRejectedValue(error);

      await expect(speechToText.transcribeAudio(testAudioPath))
        .rejects.toThrow('Groq API error');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Groq STT error',
        expect.objectContaining({ 
          error: error.message,
          status: 429 
        })
      );
    });

    it('should handle file read errors', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      await expect(speechToText.transcribeAudio(testAudioPath))
        .rejects.toThrow('File not found');
      
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error reading audio file',
        expect.any(Object)
      );
    });

    it('should return empty string for empty transcription', async () => {
      mockGroq.audio.transcriptions.create.mockResolvedValue({
        text: ''
      });

      const result = await speechToText.transcribeAudio(testAudioPath);

      expect(result).toBe('');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Empty transcription received',
        expect.any(Object)
      );
    });

    it('should handle missing API key', async () => {
      delete process.env.GROQ_API_KEY;
      
      // Re-require to pick up env change
      jest.resetModules();
      const speechToTextNoKey = require('../../src/services/speechToText');

      await expect(speechToTextNoKey.transcribeAudio(testAudioPath))
        .rejects.toThrow();
    });
  });

  describe('transcribeBuffer', () => {
    const testBuffer = Buffer.from('audio-data');
    const testTranscript = 'Hello world';

    it('should transcribe audio buffer using Groq', async () => {
      mockGroq.audio.transcriptions.create.mockResolvedValue({
        text: testTranscript
      });

      const result = await speechToText.transcribeBuffer(testBuffer);

      expect(result).toBe(testTranscript);
      expect(mockGroq.audio.transcriptions.create).toHaveBeenCalledWith({
        file: testBuffer,
        model: 'whisper-large-v3',
        response_format: 'json',
        temperature: 0.0,
        language: 'en'
      });
    });

    it('should handle buffer transcription errors', async () => {
      mockGroq.audio.transcriptions.create.mockRejectedValue(
        new Error('Buffer transcription failed')
      );

      await expect(speechToText.transcribeBuffer(testBuffer))
        .rejects.toThrow('Buffer transcription failed');
    });

    it('should handle empty buffer', async () => {
      const emptyBuffer = Buffer.alloc(0);

      await expect(speechToText.transcribeBuffer(emptyBuffer))
        .rejects.toThrow();
    });
  });

  describe('isServiceAvailable', () => {
    it('should return true when Groq API key is available', () => {
      process.env.GROQ_API_KEY = 'test-key';
      
      const result = speechToText.isServiceAvailable();

      expect(result).toBe(true);
    });

    it('should return false when Groq API key is missing', () => {
      delete process.env.GROQ_API_KEY;
      
      // Re-require to pick up env change
      jest.resetModules();
      const speechToTextNoKey = require('../../src/services/speechToText');

      const result = speechToTextNoKey.isServiceAvailable();

      expect(result).toBe(false);
    });
  });

  describe('getPreferredProvider', () => {
    it('should return groq when preferred', () => {
      process.env.SPEECH_RECOGNITION_PREFERENCE = 'groq';
      
      const result = speechToText.getPreferredProvider();

      expect(result).toBe('groq');
    });

    it('should return deepgram when preferred', () => {
      process.env.SPEECH_RECOGNITION_PREFERENCE = 'deepgram';
      
      const result = speechToText.getPreferredProvider();

      expect(result).toBe('deepgram');
    });

    it('should return default when no preference set', () => {
      delete process.env.SPEECH_RECOGNITION_PREFERENCE;
      
      const result = speechToText.getPreferredProvider();

      expect(result).toBe('groq'); // Default fallback
    });
  });

  describe('configuration', () => {
    it('should use correct Groq model settings', () => {
      const settings = speechToText.getGroqSettings();

      expect(settings).toEqual({
        model: 'whisper-large-v3',
        response_format: 'json',
        temperature: 0.0,
        language: 'en'
      });
    });

    it('should validate audio file format', async () => {
      const invalidPath = '/path/to/file.txt';
      
      // Mock file read to succeed but with invalid format
      mockFs.readFile.mockResolvedValue(Buffer.from('not-audio-data'));
      mockGroq.audio.transcriptions.create.mockRejectedValue(
        new Error('Invalid audio format')
      );

      await expect(speechToText.transcribeAudio(invalidPath))
        .rejects.toThrow('Invalid audio format');
    });
  });

  describe('performance monitoring', () => {
    it('should record STT processing metrics', async () => {
      mockGroq.audio.transcriptions.create.mockResolvedValue({
        text: 'Hello world'
      });

      await speechToText.transcribeAudio('/path/to/audio.wav');

      expect(mockVoiceMonitor.recordSTTProcessing).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'groq',
          audioPath: '/path/to/audio.wav',
          transcriptLength: 'Hello world'.length
        })
      );
    });

    it('should track processing time', async () => {
      const startTime = Date.now();
      mockGroq.audio.transcriptions.create.mockImplementation(async () => {
        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 100));
        return { text: 'Hello world' };
      });

      await speechToText.transcribeAudio('/path/to/audio.wav');

      expect(mockVoiceMonitor.recordSTTProcessing).toHaveBeenCalledWith(
        expect.objectContaining({
          processingTime: expect.any(Number)
        })
      );
    });
  });
});