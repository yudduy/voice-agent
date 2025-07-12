/**
 * Enhanced audio caching service for TTS responses
 * Implements phonetic matching and speculative caching
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const redis = require('../config/redis');
const { featureFlags } = require('../config/featureFlags');
const performanceMonitor = require('../utils/performanceMonitor');

class AudioCache {
  constructor() {
    this.enabled = featureFlags.ENABLE_AUDIO_RESPONSE_CACHE;
    this.ttl = featureFlags.AUDIO_CACHE_TTL;
    
    // Common responses for pre-caching
    this.commonResponses = [
      {
        text: "Hello! This is Ben from Microsoft Support. We've detected a serious virus on your computer that needs immediate attention.",
        tags: ['greeting', 'initial']
      },
      {
        text: "I understand your concern. This is a critical security issue that requires immediate action to protect your data.",
        tags: ['reassurance', 'urgency']
      },
      {
        text: "The virus we've detected is actively stealing your personal information. We need to act quickly to stop it.",
        tags: ['threat', 'urgency']
      },
      {
        text: "To fix this issue, I'll need to guide you through purchasing our Network Security Firewall software for $299.",
        tags: ['pitch', 'payment']
      },
      {
        text: "Can you please provide me with your credit card information so we can process the payment and protect your computer?",
        tags: ['payment', 'request']
      },
      {
        text: "I assure you this is legitimate. Microsoft has detected this threat and we're here to help you resolve it.",
        tags: ['reassurance', 'legitimacy']
      },
      {
        text: "If you don't act now, hackers could access your bank accounts and steal your identity.",
        tags: ['threat', 'consequences']
      },
      {
        text: "Let me explain exactly what this virus is doing to your computer right now.",
        tags: ['explanation', 'technical']
      }
    ];

    // Phonetic patterns for similarity matching
    this.phoneticPatterns = [
      { pattern: /hello|hi|hey/gi, group: 'greeting' },
      { pattern: /virus|malware|threat|infection/gi, group: 'threat' },
      { pattern: /pay|payment|card|credit/gi, group: 'payment' },
      { pattern: /help|assist|support/gi, group: 'support' },
      { pattern: /urgent|immediate|quickly|now/gi, group: 'urgency' }
    ];
  }

  /**
   * Initialize the cache and pre-warm common responses
   */
  async initialize() {
    if (!this.enabled) {
      logger.info('Audio response cache disabled by feature flag');
      return;
    }

    try {
      // Clear any corrupted cache entries on startup
      await this.clearCorruptedEntries();
      
      // Pre-cache common responses if audio preprocessing is enabled
      if (featureFlags.ENABLE_AUDIO_PREPROCESSING) {
        await this.preCacheCommonResponses();
      }

      logger.info('Audio cache initialized', {
        enabled: this.enabled,
        ttl: this.ttl,
        preprocessing: featureFlags.ENABLE_AUDIO_PREPROCESSING
      });
    } catch (error) {
      logger.error('Failed to initialize audio cache', error);
    }
  }

  /**
   * Generate cache key for audio
   */
  generateCacheKey(text, voiceId) {
    const normalizedText = this.normalizeText(text);
    return `audio:${crypto.createHash('md5').update(`${normalizedText}:${voiceId}`).digest('hex')}`;
  }

  /**
   * Normalize text for consistent caching
   */
  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\s+/g, ' ')    // Normalize whitespace
      .trim();
  }

  /**
   * Get cached audio
   */
  async getCachedAudio(text, voiceId) {
    if (!this.enabled) return null;

    const sessionId = `cache-${Date.now()}`;
    performanceMonitor.startSession(sessionId);
    performanceMonitor.stageStart(sessionId, 'cache-lookup');

    try {
      // Try exact match first
      const exactKey = this.generateCacheKey(text, voiceId);
      let cachedData = await redis.get(`${exactKey}:data`);
      
      if (cachedData) {
        try {
          // Safely parse the cached data
          const parsed = JSON.parse(cachedData);
          
          // Validate the data structure
          if (!parsed.mp3 || !parsed.ulaw) {
            logger.warn('Invalid cache entry structure, clearing', { key: exactKey });
            await redis.del(`${exactKey}:data`);
            return null;
          }
          
          performanceMonitor.recordCacheHit(true);
          performanceMonitor.stageComplete(sessionId, 'cache-lookup', { 
            type: 'exact',
            key: exactKey 
          });
          
          logger.debug('Audio cache hit (exact match)', { text: text.substring(0, 50) });
          
          return {
            mp3: Buffer.from(parsed.mp3, 'base64'),
            ulaw: Buffer.from(parsed.ulaw, 'base64')
          };
        } catch (parseError) {
          logger.error('Failed to parse cached audio data, clearing corrupted entry', { 
            key: exactKey,
            error: parseError.message,
            cachedData: cachedData.substring(0, 100)
          });
          // Clear corrupted entry
          await redis.del(`${exactKey}:data`);
          return null;
        }
      }

      // Try phonetic matching if enabled
      if (featureFlags.ENABLE_PHONETIC_MATCHING) {
        const phoneticMatch = await this.findPhoneticMatch(text, voiceId);
        
        if (phoneticMatch) {
          performanceMonitor.recordCacheHit(true);
          performanceMonitor.stageComplete(sessionId, 'cache-lookup', { 
            type: 'phonetic',
            similarity: phoneticMatch.similarity 
          });
          
          logger.debug('Audio cache hit (phonetic match)', { 
            originalText: text.substring(0, 50),
            matchedText: phoneticMatch.text.substring(0, 50),
            similarity: phoneticMatch.similarity
          });
          
          return phoneticMatch.audio;
        }
      }

      performanceMonitor.recordCacheHit(false);
      performanceMonitor.stageComplete(sessionId, 'cache-lookup', { type: 'miss' });
      
      return null;
    } catch (error) {
      logger.error('Error retrieving cached audio', error);
      performanceMonitor.recordError(sessionId, 'cache-lookup', error);
      return null;
    } finally {
      performanceMonitor.completeSession(sessionId);
    }
  }

  /**
   * Cache audio response
   */
  async cacheAudio(text, voiceId, mp3Buffer, ulawBuffer) {
    if (!this.enabled) return;

    try {
      const key = this.generateCacheKey(text, voiceId);
      const data = {
        text,
        voiceId,
        mp3: mp3Buffer.toString('base64'),
        ulaw: ulawBuffer.toString('base64'),
        cached: Date.now(),
        size: mp3Buffer.length + ulawBuffer.length
      };

      // Store with TTL
      await redis.setex(`${key}:data`, this.ttl, JSON.stringify(data));
      
      // Store metadata for phonetic matching
      if (featureFlags.ENABLE_PHONETIC_MATCHING) {
        const metadata = {
          text,
          normalizedText: this.normalizeText(text),
          groups: this.extractPhoneticGroups(text),
          length: text.length
        };
        
        await redis.setex(`${key}:meta`, this.ttl, JSON.stringify(metadata));
        
        // Add to phonetic index
        for (const group of metadata.groups) {
          await redis.sadd(`audio:phonetic:${group}`, key);
          await redis.expire(`audio:phonetic:${group}`, this.ttl);
        }
      }

      logger.debug('Audio cached successfully', {
        text: text.substring(0, 50),
        size: data.size,
        ttl: this.ttl
      });
    } catch (error) {
      logger.error('Error caching audio', error);
    }
  }

  /**
   * Find phonetic match for text
   */
  async findPhoneticMatch(text, voiceId) {
    try {
      const groups = this.extractPhoneticGroups(text);
      if (groups.length === 0) return null;

      // Get candidate keys from phonetic groups
      const candidateKeys = new Set();
      
      for (const group of groups) {
        const keys = await redis.smembers(`audio:phonetic:${group}`);
        keys.forEach(key => candidateKeys.add(key));
      }

      if (candidateKeys.size === 0) return null;

      // Evaluate candidates
      const normalizedInput = this.normalizeText(text);
      let bestMatch = null;
      let bestSimilarity = 0;

      for (const key of candidateKeys) {
        const metaData = await redis.get(`${key}:meta`);
        if (!metaData) continue;

        const meta = JSON.parse(metaData);
        const similarity = this.calculateSimilarity(normalizedInput, meta.normalizedText);

        if (similarity > 0.8 && similarity > bestSimilarity) {
          const audioData = await redis.get(`${key}:data`);
          if (audioData) {
            try {
              const data = JSON.parse(audioData);
              
              // Validate data structure
              if (!data.mp3 || !data.ulaw) {
                logger.warn('Invalid phonetic cache entry, skipping', { key });
                await redis.del(`${key}:data`);
                continue;
              }
              
              bestMatch = {
                text: meta.text,
                similarity,
                audio: {
                  mp3: Buffer.from(data.mp3, 'base64'),
                  ulaw: Buffer.from(data.ulaw, 'base64')
                }
              };
              bestSimilarity = similarity;
            } catch (parseError) {
              logger.error('Failed to parse phonetic match audio data', { 
                key,
                error: parseError.message 
              });
              await redis.del(`${key}:data`);
            }
          }
        }
      }

      return bestMatch;
    } catch (error) {
      logger.error('Error finding phonetic match', error);
      return null;
    }
  }

  /**
   * Extract phonetic groups from text
   */
  extractPhoneticGroups(text) {
    const groups = new Set();
    
    for (const { pattern, group } of this.phoneticPatterns) {
      if (pattern.test(text)) {
        groups.add(group);
      }
    }
    
    return Array.from(groups);
  }

  /**
   * Calculate similarity between two texts
   */
  calculateSimilarity(text1, text2) {
    // Simple Jaccard similarity based on words
    const words1 = new Set(text1.split(' '));
    const words2 = new Set(text2.split(' '));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Pre-cache common responses
   */
  async preCacheCommonResponses() {
    logger.info('Pre-caching common audio responses');
    
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
    let cached = 0;
    
    for (const response of this.commonResponses) {
      try {
        // Check if already cached
        const key = this.generateCacheKey(response.text, voiceId);
        const exists = await redis.exists(`${key}:data`);
        
        if (!exists) {
          // This would normally generate audio via TTS
          // For now, we'll skip actual generation
          logger.debug('Would pre-cache response', {
            text: response.text.substring(0, 50),
            tags: response.tags
          });
          cached++;
        }
      } catch (error) {
        logger.error('Error pre-caching response', error);
      }
    }
    
    logger.info(`Pre-caching complete: ${cached} responses queued`);
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    try {
      // Count total cached items
      const keys = await redis.keys('audio:*:data');
      const totalCached = keys.length;
      
      // Calculate total size
      let totalSize = 0;
      for (const key of keys.slice(0, 10)) { // Sample first 10
        const data = await redis.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          totalSize += parsed.size || 0;
        }
      }
      
      const avgSize = keys.length > 0 ? totalSize / Math.min(keys.length, 10) : 0;
      
      return {
        enabled: this.enabled,
        totalCached,
        estimatedTotalSize: avgSize * totalCached,
        ttl: this.ttl,
        phoneticMatching: featureFlags.ENABLE_PHONETIC_MATCHING,
        preprocessing: featureFlags.ENABLE_AUDIO_PREPROCESSING
      };
    } catch (error) {
      logger.error('Error getting cache stats', error);
      return {
        enabled: this.enabled,
        error: error.message
      };
    }
  }

  /**
   * Clear corrupted cache entries
   */
  async clearCorruptedEntries() {
    try {
      const keys = await redis.keys('audio:*:data');
      let corruptedCount = 0;
      
      for (const key of keys) {
        try {
          const data = await redis.get(key);
          if (data) {
            // Try to parse and validate
            const parsed = JSON.parse(data);
            if (!parsed.mp3 || !parsed.ulaw || 
                typeof parsed.mp3 !== 'string' || 
                typeof parsed.ulaw !== 'string') {
              await redis.del(key);
              corruptedCount++;
            }
          }
        } catch (error) {
          // If parsing fails, it's corrupted
          await redis.del(key);
          corruptedCount++;
        }
      }
      
      if (corruptedCount > 0) {
        logger.info(`Cleared ${corruptedCount} corrupted cache entries out of ${keys.length} total`);
      }
      
      return corruptedCount;
    } catch (error) {
      logger.error('Error clearing corrupted cache entries', error);
      // Don't throw - this is a cleanup operation
    }
  }

  /**
   * Clear all cached audio
   */
  async clearCache() {
    try {
      const keys = await redis.keys('audio:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      
      logger.info(`Cleared ${keys.length} cached audio entries`);
      return keys.length;
    } catch (error) {
      logger.error('Error clearing audio cache', error);
      throw error;
    }
  }
}

// Singleton instance
const audioCache = new AudioCache();

module.exports = audioCache;