/**
 * Speech to text service
 * 
 * Note: This service is optional since Twilio's <Gather> verb provides speech recognition.
 * However, we're including it for future extensibility or to implement custom speech recognition.
 */
const logger = require('../utils/logger');
const aiConfig = require('../config/ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Groq = require('groq-sdk'); // Use Groq SDK

// Initialize Groq client if enabled and key is provided
let groqClient;
if (aiConfig.groqConfig.enabled) {
  try {
    groqClient = new Groq({ apiKey: aiConfig.groqConfig.apiKey });
    logger.info('Groq client initialized for STT.');
  } catch (error) {
     logger.error('Failed to initialize Groq client', { error: error.message });
     // Groq STT will be effectively disabled
  }
} else if (process.env.NODE_ENV !== 'test' && !process.env.INTEGRATION_TEST) {
  // Only log the warning if not in a test environment, to reduce noise.
  logger.warn('Groq STT is disabled in configuration or API key is missing.');
}

/**
 * Transcribe audio using Groq Whisper API.
 * @param {string} audioUrl - URL of the audio file (e.g., from Twilio RecordingUrl)
 * @returns {Promise<string|null>} - Transcribed text or null on failure
 */
const transcribeWithGroq = async (audioUrl) => {
  // Check if Groq client is available and operational
  if (!groqClient) {
    logger.debug('Groq STT skipped: Groq client not initialized or enabled.');
    return null;
  }
  if (!audioUrl) {
    logger.warn('Groq STT skipped: No audio URL provided.');
    return null;
  }

  let tempFilePath = null;
  try {
    // 1. Download the audio file
    logger.debug('Downloading audio for Groq transcription...', { audioUrl });
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream',
      // Add Twilio Auth if accessing protected recordings (optional)
      // auth: { username: twilioConfig.accountSid, password: twilioConfig.authToken }
    });

    // Create a temporary file path
    const tempDir = os.tmpdir();
    const urlHash = require('crypto').createHash('md5').update(audioUrl).digest('hex');
    // Ensure file extension is appropriate (Groq might be flexible, but WAV/MP3 are safe)
    const fileExtension = audioUrl.split('.').pop().toLowerCase() || 'mp3'; 
    tempFilePath = path.join(tempDir, `groq_audio_${urlHash}.${fileExtension}`);

    // Pipe the download stream to the temporary file
    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject); // Handle download errors
    });
    logger.debug('Audio downloaded successfully to temp file', { tempFilePath });

    // 2. Send audio to Groq API
    logger.debug('Sending audio to Groq API...', { model: aiConfig.groqConfig.whisperModel });
    const transcription = await groqClient.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: aiConfig.groqConfig.whisperModel, 
      // language: 'en', // Optional: specify language if needed
      // response_format: 'json', // Default
      // temperature: 0, // Optional: control randomness
    });

    logger.info('Groq transcription successful', { textLength: transcription.text?.length });
    return transcription.text; // Return the transcribed text

  } catch (error) {
    // Log specific Groq API errors if possible
    logger.error('Error during Groq transcription process', {
      error: error.response ? { status: error.response.status, data: error.response.data } : error.message,
      errorCode: error.code, // Groq SDK might provide specific error codes
      audioUrl
    });
    return null;
  } finally {
    // 3. Clean up the temporary file
    if (tempFilePath) {
      try {
        // Use async unlink
        await fs.promises.unlink(tempFilePath);
        logger.debug('Temporary Groq audio file deleted', { tempFilePath });
      } catch (cleanupError) {
        logger.warn('Failed to delete temporary Groq audio file', { tempFilePath, error: cleanupError.message });
      }
    }
  }
};

/**
 * Process Twilio speech recognition result
 * @param {string} speechResult - Twilio's SpeechResult
 * @returns {string} - Processed text
 */
const processTwilioSpeechResult = (speechResult) => {
  const processedText = speechResult ? speechResult.trim() : '';
  return processedText;
};

/**
 * Validate speech recognition result
 * @param {string} speechResult - Transcribed text
 * @param {number} [confidence] - Optional confidence score (e.g., from Twilio)
 * @returns {boolean} - Whether the result is valid
 */
const validateSpeechResult = (speechResult, confidence) => {
  if (!speechResult || speechResult.trim().length === 0) {
    return false;
  }
  // Add confidence check if needed (using telephonyConfig)
  // if (confidence !== undefined && confidence < telephonyConfig.minSpeechConfidence) { ... }
  return true;
};

module.exports = {
  transcribeWithGroq, // Export new function
  processTwilioSpeechResult,
  validateSpeechResult,
  // transcribeWithWhisper, // Remove or comment out old OpenAI function if no longer needed
};
