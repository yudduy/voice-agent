const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Mock dependencies
jest.mock('axios');
jest.mock('fs').promises;
jest.mock('../../src/utils/logger');
jest.mock('../../src/utils/voiceMonitor');
jest.mock('../../src/config', () => ({
  cache: {
    tts: {
      directory: './test-cache',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }
}));

describe('TextToSpeech Service', () => {
  let textToSpeech;
  let mockLogger;
  let mockVoiceMonitor;
  let mockFs;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    mockVoiceMonitor = require('../../src/utils/voiceMonitor');
    mockFs = require('fs').promises;
    
    // Default mock implementations
    mockFs.access = jest.fn().mockRejectedValue(new Error('Not found'));
    mockFs.writeFile = jest.fn().mockResolvedValue();
    mockFs.readdir = jest.fn().mockResolvedValue([]);
    mockFs.stat = jest.fn().mockResolvedValue({ mtime: new Date() });
    mockFs.unlink = jest.fn().mockResolvedValue();
    
    mockVoiceMonitor.recordTTSGeneration = jest.fn();

    // Set environment variables
    process.env.ELEVENLABS_API_KEY = 'test-api-key';
    process.env.ELEVENLABS_VOICE_ID = 'test-voice-id';
    process.env.TTS_PREFERENCE = 'elevenlabs';

    // Require after mocks are set up
    textToSpeech = require('../../src/services/textToSpeech');
  });

  describe('generateSpeech', () => {
    const testText = 'Hello world';
    const expectedHash = crypto.createHash('md5').update(testText).digest('hex');
    const expectedFilename = `tts_${expectedHash}.wav`;
    const expectedPath = path.join('./test-cache', expectedFilename);

    it('should return cached file if it exists', async () => {
      mockFs.access.mockResolvedValue(); // File exists

      const result = await textToSpeech.generateSpeech(testText);

      expect(result).toBe(expectedPath);
      expect(mockFs.access).toHaveBeenCalledWith(expectedPath);
      expect(axios.post).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Using cached TTS audio',
        expect.objectContaining({ filename: expectedFilename })
      );
    });

    it('should generate new audio when not cached', async () => {
      const audioData = Buffer.from('test-audio-data');
      axios.post.mockResolvedValue({ data: audioData });

      const result = await textToSpeech.generateSpeech(testText);

      expect(result).toBe(expectedPath);
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('https://api.elevenlabs.io/v1/text-to-speech'),
        expect.objectContaining({ text: testText }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'xi-api-key': 'test-api-key'
          }),
          responseType: 'arraybuffer'
        })
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(expectedPath, audioData);
      expect(mockVoiceMonitor.recordTTSGeneration).toHaveBeenCalled();
    });

    it('should handle ElevenLabs API errors', async () => {
      const error = new Error('API Error');
      error.response = { status: 429, data: 'Rate limit exceeded' };
      axios.post.mockRejectedValue(error);

      await expect(textToSpeech.generateSpeech(testText)).rejects.toThrow('API Error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ElevenLabs API error',
        expect.objectContaining({ status: 429 })
      );
    });

    it('should handle file write errors', async () => {
      axios.post.mockResolvedValue({ data: Buffer.from('audio') });
      mockFs.writeFile.mockRejectedValue(new Error('Write failed'));

      await expect(textToSpeech.generateSpeech(testText)).rejects.toThrow('Write failed');
    });

    it('should sanitize special characters from text', async () => {
      const specialText = 'Hello <break time="1s"/> world!';
      const sanitizedText = 'Hello world!';
      
      axios.post.mockResolvedValue({ data: Buffer.from('audio') });

      await textToSpeech.generateSpeech(specialText);

      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: sanitizedText }),
        expect.any(Object)
      );
    });
  });

  describe('streamTextToSpeech', () => {
    it('should stream text and return audio path', async () => {
      const text = 'Stream this text';
      const audioPath = '/path/to/audio.wav';
      
      // Mock generateSpeech to return the path
      textToSpeech.generateSpeech = jest.fn().mockResolvedValue(audioPath);

      const result = await textToSpeech.streamTextToSpeech(text, 'call-123');

      expect(result).toBe(audioPath);
      expect(textToSpeech.generateSpeech).toHaveBeenCalledWith(text);
    });

    it('should handle streaming errors', async () => {
      textToSpeech.generateSpeech = jest.fn().mockRejectedValue(new Error('Stream failed'));

      await expect(textToSpeech.streamTextToSpeech('text', 'call-123'))
        .rejects.toThrow('Stream failed');
    });
  });

  describe('cleanupCache', () => {
    it('should remove old cache files', async () => {
      const oldFile = 'old-file.wav';
      const newFile = 'new-file.wav';
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days old
      const newDate = new Date();

      mockFs.readdir.mockResolvedValue([oldFile, newFile]);
      mockFs.stat
        .mockResolvedValueOnce({ mtime: oldDate })
        .mockResolvedValueOnce({ mtime: newDate });

      await textToSpeech.cleanupCache();

      expect(mockFs.unlink).toHaveBeenCalledTimes(1);
      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join('./test-cache', oldFile)
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleaned up TTS cache',
        expect.objectContaining({ filesRemoved: 1 })
      );
    });

    it('should handle cleanup errors gracefully', async () => {
      mockFs.readdir.mockRejectedValue(new Error('Read failed'));

      await textToSpeech.cleanupCache();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error cleaning up TTS cache',
        expect.any(Object)
      );
    });

    it('should handle individual file deletion errors', async () => {
      mockFs.readdir.mockResolvedValue(['file1.wav', 'file2.wav']);
      mockFs.stat.mockResolvedValue({ mtime: new Date(0) }); // Very old
      mockFs.unlink
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('Delete failed'));

      await textToSpeech.cleanupCache();

      expect(mockFs.unlink).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error removing cache file',
        expect.any(Object)
      );
    });
  });

  describe('getVoiceSettings', () => {
    it('should return default voice settings', () => {
      const settings = textToSpeech.getVoiceSettings();

      expect(settings).toEqual({
        stability: 0.71,
        similarity_boost: 0.8,
        style: 0,
        use_speaker_boost: true
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty text', async () => {
      await expect(textToSpeech.generateSpeech('')).rejects.toThrow();
    });

    it('should handle very long text', async () => {
      const longText = 'a'.repeat(5000);
      axios.post.mockResolvedValue({ data: Buffer.from('audio') });

      const result = await textToSpeech.generateSpeech(longText);

      expect(result).toBeDefined();
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: longText }),
        expect.any(Object)
      );
    });

    it('should handle missing API key', async () => {
      delete process.env.ELEVENLABS_API_KEY;
      
      // Re-require to pick up env change
      jest.resetModules();
      const textToSpeechNoKey = require('../../src/services/textToSpeech');

      await expect(textToSpeechNoKey.generateSpeech('test'))
        .rejects.toThrow();
    });
  });
});