/**
 * Text to speech service
 * 
 * Now supports ElevenLabs as the primary TTS provider with Hyperbolic as fallback.
 * Twilio's <Say> verb remains as the final fallback.
 */
const logger = require('../utils/logger');
const telephonyConfig = require('../config/telephony');
const aiConfig = require('../config/ai');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// In-memory cache for generated audio URLs
const ttsCache = new Map();
const TTS_CACHE_DIR = path.join(__dirname, '..', '..', 'public', 'tts-cache');
const HYPERBOLIC_CHUNK_THRESHOLD = 150; // Characters - Adjust based on testing
const ELEVENLABS_CHUNK_THRESHOLD = 2500; // ElevenLabs can handle larger chunks

// Ensure cache directory exists
fs.mkdir(TTS_CACHE_DIR, { recursive: true })
  .catch(err => logger.error('Error creating TTS cache directory', { error: err.message }));

/**
 * Generate a cache key for TTS request.
 * Uses text and options to create a unique hash.
 */
const generateCacheKey = (text, options, provider = 'default') => {
  const keyString = JSON.stringify({ text, provider, ...options });
  return crypto.createHash('md5').update(keyString).digest('hex');
};

/**
 * Preprocess text for Hyperbolic TTS API.
 * Removes potentially problematic characters or formatting.
 */
const preprocessTextForHyperbolic = (text) => {
  // Basic sanitization: Remove markdown-like symbols, extra whitespace
  let sanitized = text
    .replace(/[*_`~]/g, '') // Remove common markdown chars
    .replace(/\s{2,}/g, ' ') // Replace multiple spaces with one
    .trim();
  
  // Add more specific replacements if certain patterns cause 422 errors
  // e.g., replace complex punctuation, normalize quotes, etc.
  
  // Ensure it's not empty after sanitization
  if (!sanitized) {
    logger.warn('Text became empty after sanitization', { original: text });
    return '.'; // Return a minimal valid character if empty
  }
  
  return sanitized;
};

/**
 * Send a single chunk of text to Hyperbolic API.
 * Includes retry logic with text simplification on failure.
 */
const sendChunkToHyperbolic = async (textChunk, requestOptionsBase, cacheKey) => {
  let attempts = 0;
  const maxAttempts = 3;
  let currentText = textChunk;

  while (attempts < maxAttempts) {
    const requestOptions = {
      ...requestOptionsBase,
      data: { ...requestOptionsBase.data, text: currentText },
    };
    
    try {
      logger.debug('Calling Hyperbolic TTS API for chunk', { attempt: attempts + 1, textLength: currentText.length });
      const response = await axios(requestOptions);

      if (response.data && response.data.audio) {
        return response.data.audio; // Return base64 audio data on success
      } else {
        logger.warn('Hyperbolic TTS API response missing audio data for chunk', { responseStatus: response.status });
        return null; // Indicate failure for this chunk
      }
    } catch (error) {
      attempts++;
      const is422 = error.response && error.response.status === 422;
      logger.error(`Error calling Hyperbolic TTS API (Attempt ${attempts}/${maxAttempts})`, {
        error: error.response ? { status: error.response.status, data: error.response.data } : error.message,
        textChunk: currentText, // Log the problematic chunk
        is422
      });

      if (attempts >= maxAttempts) {
        logger.error('Hyperbolic TTS chunk failed after max attempts');
        return null;
      }

      // Intelligent Retry for 422: Simplify text
      if (is422 && attempts < maxAttempts) {
         logger.warn('Got 422 error, attempting to simplify text for retry...', { cacheKey });
         // Simple simplification: remove more punctuation, shorten if possible
         currentText = currentText.replace(/[!?"';:,.]/g, '').trim(); 
         if (currentText.length > 100) { // Arbitrary shortening
             currentText = currentText.substring(0, 100) + '...';
         }
         if (!currentText) currentText = 'Error processing previous text.'; // Fallback if empty
         logger.debug('Simplified text for retry:', { simplifiedText: currentText });
      } else {
        // General retry delay
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }
  }
  return null; // Indicate failure after retries
};

/**
 * Core function to generate audio with Hyperbolic API.
 * Handles preprocessing, chunking, API calls, caching, and file saving.
 * @param {string} text - Text to synthesize
 * @param {object} options - Options (e.g., speaker, speed)
 * @returns {Promise<string|null>} - URL to the generated audio file or null on failure
 */
const generateHyperbolicAudio = async (text, options = {}) => {
  if (!aiConfig.hyperbolic.enabled) {
    logger.debug('Hyperbolic TTS is disabled.');
    return null;
  }

  const preprocessedText = preprocessTextForHyperbolic(text);
  if (!preprocessedText || preprocessedText === '.') {
      logger.warn('Skipping Hyperbolic TTS due to empty/invalid preprocessed text.', { originalText: text });
      return null;
  }

  // Use preprocessed text for caching and API calls
  const cacheKey = generateCacheKey(preprocessedText, options);
  if (ttsCache.has(cacheKey)) {
    const cachedUrl = ttsCache.get(cacheKey);
    try {
      await fs.access(path.join(TTS_CACHE_DIR, path.basename(cachedUrl)));
      logger.debug('Returning cached Hyperbolic TTS audio', { key: cacheKey, url: cachedUrl });
      return cachedUrl;
    } catch (error) { 
      logger.warn('Cached TTS file not found, removing from cache', { key: cacheKey, url: cachedUrl });
      ttsCache.delete(cacheKey);
    }
  }

  // Split into chunks if necessary
  const textChunks = splitIntoSpeechChunks(preprocessedText, HYPERBOLIC_CHUNK_THRESHOLD);
  logger.debug(`Splitting text into ${textChunks.length} chunks for Hyperbolic`, { totalLength: preprocessedText.length });

  const baseRequestOptions = {
    method: 'POST',
    url: aiConfig.hyperbolic.ttsEndpoint,
    headers: {
      'Authorization': `Bearer ${aiConfig.hyperbolic.apiKey}`,
      'Content-Type': 'application/json',
    },
    data: {
      ...aiConfig.hyperbolic.defaultOptions, // Apply defaults
      ...options, // Override with specific options
      // text field will be added per chunk
    },
    responseType: 'json',
  };

  const audioBuffers = [];
  let success = true;

  for (const chunk of textChunks) {
    const audioBase64 = await sendChunkToHyperbolic(chunk, baseRequestOptions, cacheKey);
    if (audioBase64) {
      audioBuffers.push(Buffer.from(audioBase64, 'base64'));
    } else {
      logger.error('Failed to generate audio for a chunk, aborting Hyperbolic TTS for this request.', { cacheKey });
      success = false;
      break; // Stop processing chunks if one fails
    }
  }

  if (!success || audioBuffers.length === 0) {
    return null; // Return null if any chunk failed
  }

  // Combine audio buffers
  const combinedBuffer = Buffer.concat(audioBuffers);
  const filename = `${cacheKey}.mp3`;
  const filePath = path.join(TTS_CACHE_DIR, filename);

  try {
    await fs.writeFile(filePath, combinedBuffer);
    const audioUrl = `/tts-cache/${filename}`; // URL relative to server root
    logger.info('Successfully generated and combined Hyperbolic TTS audio', { filename, chunks: textChunks.length });
    ttsCache.set(cacheKey, audioUrl); // Cache the final URL
    return audioUrl;
  } catch (writeError) {
    logger.error('Failed to write combined Hyperbolic audio file', { filename, error: writeError.message });
    return null;
  }
};

/**
 * Format text for optimal speech synthesis
 * @param {string} text - The text to format
 * @returns {string} - Formatted text
 */
const formatTextForSpeech = (text) => {
  // Format text to sound more natural when spoken
  // Replace acronyms, format numbers, etc.
  
  // Example: replace "AI" with "A I" for better pronunciation
  let formattedText = text
    .replace(/\bAI\b/g, 'A I')
    .replace(/\bUI\b/g, 'U I')
    .replace(/\bAPI\b/g, 'A P I');
  
  // Format phone numbers for better speech
  formattedText = formattedText.replace(
    /(\d{3})[- ]?(\d{3})[- ]?(\d{4})/g, 
    '$1 $2 $3'
  );
  
  return formattedText;
};

/**
 * Get Twilio TTS configuration
 * @returns {Object} - Twilio TTS options
 */
const getTwilioTtsOptions = () => {
  return {
    voice: telephonyConfig.voice,
    language: telephonyConfig.language
  };
};

/**
 * Split long text into digestible chunks for TTS
 * @param {string} text - Long text
 * @param {number} maxLength - Maximum length of each chunk
 * @returns {Array<string>} - Array of text chunks
 */
const splitIntoSpeechChunks = (text, maxLength = 500) => {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  
  // Split by sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length <= maxLength) {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    } else {
      chunks.push(currentChunk);
      currentChunk = sentence;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
};

/**
 * Core function to generate audio with ElevenLabs API.
 * @param {string} text - Text to synthesize
 * @param {object} options - Options (e.g., voice_id, voice_settings)
 * @returns {Promise<string|null>} - URL to the generated audio file or null on failure
 */
const generateElevenLabsAudio = async (text, options = {}) => {
  if (!aiConfig.elevenLabs.enabled) {
    logger.debug('ElevenLabs TTS is disabled.');
    return null;
  }

  if (!text || text.trim().length === 0) {
    logger.warn('Skipping ElevenLabs TTS due to empty text.');
    return null;
  }

  const voiceId = options.voice_id || aiConfig.elevenLabs.voiceId;
  const cacheKey = generateCacheKey(text, options, 'elevenlabs');
  
  // Check cache first
  if (ttsCache.has(cacheKey)) {
    const cachedUrl = ttsCache.get(cacheKey);
    try {
      await fs.access(path.join(TTS_CACHE_DIR, path.basename(cachedUrl)));
      logger.debug('Returning cached ElevenLabs TTS audio', { key: cacheKey, url: cachedUrl });
      return cachedUrl;
    } catch (error) { 
      logger.warn('Cached TTS file not found, removing from cache', { key: cacheKey, url: cachedUrl });
      ttsCache.delete(cacheKey);
    }
  }

  try {
    logger.debug('Calling ElevenLabs TTS API', { textLength: text.length, voiceId });
    
    const requestData = {
      text: text,
      ...aiConfig.elevenLabs.defaultOptions,
      ...options // Allow override of default options
    };

    const response = await axios({
      method: 'POST',
      url: `${aiConfig.elevenLabs.ttsEndpoint}/${voiceId}`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': aiConfig.elevenLabs.apiKey
      },
      data: requestData,
      responseType: 'arraybuffer'
    });

    if (response.data) {
      const filename = `${cacheKey}.mp3`;
      const filePath = path.join(TTS_CACHE_DIR, filename);
      
      await fs.writeFile(filePath, response.data);
      const audioUrl = `/tts-cache/${filename}`;
      
      logger.info('Successfully generated ElevenLabs TTS audio', { filename, textLength: text.length });
      ttsCache.set(cacheKey, audioUrl);
      return audioUrl;
    } else {
      logger.warn('ElevenLabs TTS API response missing audio data');
      return null;
    }

  } catch (error) {
    logger.error('Error calling ElevenLabs TTS API', {
      error: error.response ? { 
        status: error.response.status, 
        data: error.response.data?.toString?.() || error.response.data 
      } : error.message,
      textLength: text.length
    });
    return null;
  }
};

/**
 * Main TTS generation function that prioritizes ElevenLabs, falls back to Hyperbolic, then Twilio
 * @param {string} text - Text to synthesize
 * @param {object} options - Options for TTS
 * @returns {Promise<string|null>} - URL to the generated audio file or null if all providers fail
 */
const generateAudio = async (text, options = {}) => {
  if (!text || text.trim().length === 0) {
    logger.warn('Skipping TTS generation due to empty text.');
    return null;
  }

  const formattedText = formatTextForSpeech(text);
  
  // First try ElevenLabs if it's the preferred provider and enabled
  if (aiConfig.speechPreferences.ttsPreference === 'elevenlabs' && aiConfig.elevenLabs.enabled) {
    logger.debug('Attempting ElevenLabs TTS generation');
    const elevenLabsResult = await generateElevenLabsAudio(formattedText, options);
    if (elevenLabsResult) {
      return elevenLabsResult;
    }
    logger.warn('ElevenLabs TTS failed, falling back to next provider');
  }

  // Fall back to Hyperbolic
  if (aiConfig.hyperbolic.enabled) {
    logger.debug('Attempting Hyperbolic TTS generation as fallback');
    const hyperbolicResult = await generateHyperbolicAudio(formattedText, options);
    if (hyperbolicResult) {
      return hyperbolicResult;
    }
    logger.warn('Hyperbolic TTS failed, will use Twilio as final fallback');
  }

  // If both fail, return null and let Twilio TTS handle it
  logger.debug('All custom TTS providers failed, will use Twilio TTS');
  return null;
};

module.exports = {
  generateHyperbolicAudio,
  formatTextForSpeech,
  getTwilioTtsOptions,
  splitIntoSpeechChunks,
  generateElevenLabsAudio,
  generateAudio
};
