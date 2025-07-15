const crypto = require('crypto');

// Mock dependencies
jest.mock('../../src/utils/logger');
jest.mock('../../src/config/redis');
jest.mock('../../src/config/featureFlags', () => ({
  featureFlags: {
    ENABLE_AUDIO_RESPONSE_CACHE: true,
    AUDIO_CACHE_TTL: 3600
  }
}));
jest.mock('../../src/utils/performanceMonitor');

describe('AudioCache', () => {
  let AudioCache;
  let audioCache;
  let mockLogger;
  let mockRedis;
  let mockPerformanceMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    mockRedis = require('../../src/config/redis');
    mockPerformanceMonitor = require('../../src/utils/performanceMonitor');

    // Setup Redis mock
    mockRedis.get = jest.fn();
    mockRedis.set = jest.fn();
    mockRedis.setex = jest.fn();
    mockRedis.del = jest.fn();
    mockRedis.scan = jest.fn();

    // Setup performance monitor mock
    mockPerformanceMonitor.recordMetric = jest.fn();

    // Require after mocks are set up
    const AudioCacheClass = require('../../src/services/audioCache');
    audioCache = new AudioCacheClass();
  });

  describe('constructor', () => {
    it('should initialize with correct settings', () => {
      expect(audioCache.enabled).toBe(true);
      expect(audioCache.ttl).toBe(3600);
      expect(audioCache.commonResponses).toBeDefined();
      expect(audioCache.commonResponses.length).toBeGreaterThan(0);
    });
  });

  describe('getCacheKey', () => {
    it('should generate consistent cache keys', () => {
      const text = 'Hello world';
      const key1 = audioCache.getCacheKey(text);
      const key2 = audioCache.getCacheKey(text);
      
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^audio:tts:[a-f0-9]+$/);
    });

    it('should generate different keys for different text', () => {
      const key1 = audioCache.getCacheKey('Hello');
      const key2 = audioCache.getCacheKey('World');
      
      expect(key1).not.toBe(key2);
    });
  });

  describe('get', () => {
    it('should return cached audio path when found', async () => {
      const text = 'Hello world';
      const cachedPath = '/path/to/audio.wav';
      mockRedis.get.mockResolvedValue(cachedPath);

      const result = await audioCache.get(text);

      expect(result).toBe(cachedPath);
      expect(mockRedis.get).toHaveBeenCalledWith(audioCache.getCacheKey(text));
      expect(mockPerformanceMonitor.recordMetric).toHaveBeenCalledWith(
        'audio_cache_hit',
        1,
        { text_length: text.length }
      );
    });

    it('should return null when not found', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await audioCache.get('Hello world');

      expect(result).toBeNull();
      expect(mockPerformanceMonitor.recordMetric).toHaveBeenCalledWith(
        'audio_cache_miss',
        1,
        expect.any(Object)
      );
    });

    it('should return null when cache is disabled', async () => {
      audioCache.enabled = false;

      const result = await audioCache.get('Hello world');

      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      const result = await audioCache.get('Hello world');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get from audio cache',
        expect.any(Object)
      );
    });
  });

  describe('set', () => {
    it('should cache audio path successfully', async () => {
      const text = 'Hello world';
      const audioPath = '/path/to/audio.wav';

      await audioCache.set(text, audioPath);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        audioCache.getCacheKey(text),
        audioCache.ttl,
        audioPath
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cached audio response',
        expect.objectContaining({ text, audioPath })
      );
    });

    it('should not cache when disabled', async () => {
      audioCache.enabled = false;

      await audioCache.set('Hello world', '/path/to/audio.wav');

      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.setex.mockRejectedValue(new Error('Redis error'));

      await audioCache.set('Hello world', '/path/to/audio.wav');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to set audio cache',
        expect.any(Object)
      );
    });
  });

  describe('findSimilar', () => {
    it('should find phonetically similar cached responses', async () => {
      const text = 'Helo world';  // Misspelled
      const similarKey = audioCache.getCacheKey('Hello world');
      const audioPath = '/path/to/audio.wav';

      mockRedis.scan.mockResolvedValue([null, [similarKey]]);
      mockRedis.get.mockResolvedValue(audioPath);

      const result = await audioCache.findSimilar(text);

      expect(result).toBe(audioPath);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Found phonetically similar cached response',
        expect.any(Object)
      );
    });

    it('should return null when no similar responses found', async () => {
      mockRedis.scan.mockResolvedValue([null, []]);

      const result = await audioCache.findSimilar('Hello world');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockRedis.scan.mockRejectedValue(new Error('Redis error'));

      const result = await audioCache.findSimilar('Hello world');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to find similar audio',
        expect.any(Object)
      );
    });
  });

  describe('initialize', () => {
    it('should pre-cache common responses when enabled', async () => {
      audioCache.enabled = true;
      
      // Mock that some responses are not cached
      mockRedis.get.mockResolvedValue(null);

      await audioCache.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Audio cache initialized'),
        expect.any(Object)
      );
    });

    it('should skip pre-caching when disabled', async () => {
      audioCache.enabled = false;

      await audioCache.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith('Audio cache is disabled');
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));

      await audioCache.initialize();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize audio cache',
        expect.any(Object)
      );
    });
  });

  describe('clear', () => {
    it('should clear all audio cache entries', async () => {
      const keys = ['audio:tts:123', 'audio:tts:456'];
      mockRedis.scan.mockResolvedValue([null, keys]);

      await audioCache.clear();

      expect(mockRedis.del).toHaveBeenCalledWith(...keys);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleared audio cache',
        { count: keys.length }
      );
    });

    it('should handle empty cache', async () => {
      mockRedis.scan.mockResolvedValue([null, []]);

      await audioCache.clear();

      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleared audio cache',
        { count: 0 }
      );
    });

    it('should handle clear errors', async () => {
      mockRedis.scan.mockRejectedValue(new Error('Redis error'));

      await audioCache.clear();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to clear audio cache',
        expect.any(Object)
      );
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', async () => {
      const keys = ['audio:tts:123', 'audio:tts:456'];
      mockRedis.scan.mockResolvedValue([null, keys]);

      const stats = await audioCache.getStats();

      expect(stats).toEqual({
        enabled: true,
        entries: 2,
        ttl: 3600
      });
    });

    it('should handle stats errors', async () => {
      mockRedis.scan.mockRejectedValue(new Error('Redis error'));

      const stats = await audioCache.getStats();

      expect(stats).toEqual({
        enabled: true,
        entries: 0,
        ttl: 3600,
        error: 'Failed to get cache stats'
      });
    });
  });
});