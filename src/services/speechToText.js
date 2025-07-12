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
const { createClient } = require('@deepgram/sdk'); // Use Deepgram SDK v3

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

// Initialize Deepgram client if enabled and key is provided
let deepgramClient;
if (aiConfig.deepgramConfig && aiConfig.deepgramConfig.enabled) {
  try {
    deepgramClient = createClient(aiConfig.deepgramConfig.apiKey);
    logger.info('Deepgram client initialized for STT.');
  } catch (error) {
    logger.error('Failed to initialize Deepgram client', { error: error.message });
    // Deepgram STT will be effectively disabled
  }
} else if (process.env.NODE_ENV !== 'test' && !process.env.INTEGRATION_TEST) {
  logger.warn('Deepgram STT is disabled in configuration or API key is missing.');
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
      // Add Twilio Auth for accessing protected recordings
      auth: { 
        username: process.env.TWILIO_ACCOUNT_SID, 
        password: process.env.TWILIO_AUTH_TOKEN 
      },
      timeout: 30000 // 30 second timeout
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
    });

    logger.info('🎤 [STT-SUCCESS] Groq transcription successful', { 
      transcribedText: transcription.text,
      textLength: transcription.text?.length,
      provider: 'groq-whisper'
    });
    return transcription.text; // Return the transcribed text

  } catch (error) {
    // Log specific Groq API errors if possible - FIX CIRCULAR REFERENCE ISSUE
    const errorInfo = {};
    if (error.response) {
      errorInfo.status = error.response.status;
      errorInfo.statusText = error.response.statusText;
      errorInfo.data = error.response.data;
    } else {
      errorInfo.message = error.message;
      errorInfo.code = error.code;
      errorInfo.name = error.name;
    }
    
    logger.error('🎤 [STT-ERROR] Groq transcription failed', {
      error: errorInfo,
      audioUrl: audioUrl ? audioUrl.substring(0, 100) + '...' : 'null'
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
  
  if (processedText) {
    logger.info('🎤 [STT-SUCCESS] Twilio speech recognized', {
      transcribedText: processedText,
      textLength: processedText.length,
      provider: 'twilio'
    });
  }
  
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
  return true;
};

/**
 * Transcribe audio using Deepgram Nova-3 API.
 * @param {string} audioUrl - URL of the audio file (e.g., from Twilio RecordingUrl)
 * @returns {Promise<string|null>} - Transcribed text or null on failure
 */
const transcribeWithDeepgram = async (audioUrl) => {
  // Check if Deepgram client is available and operational
  if (!deepgramClient) {
    logger.debug('Deepgram STT skipped: Deepgram client not initialized or enabled.');
    return null;
  }
  if (!audioUrl) {
    logger.warn('Deepgram STT skipped: No audio URL provided.');
    return null;
  }

  try {
    const startTime = Date.now();
    logger.debug('Starting Deepgram transcription...', { audioUrl });

    // Deepgram v3 API call
    const response = await deepgramClient.listen.prerecorded.transcribeUrl(
      {
        url: audioUrl
      },
      {
        model: aiConfig.deepgramConfig.model || 'nova-3',
        language: aiConfig.deepgramConfig.language || 'en',
        smart_format: aiConfig.deepgramConfig.smart_format !== false,
        punctuate: aiConfig.deepgramConfig.punctuate !== false,
        diarize: aiConfig.deepgramConfig.diarize || false
      }
    );

    const transcript = response.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const confidence = response.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
    const latency = Date.now() - startTime;

    logger.info('🎤 [STT-SUCCESS] Deepgram transcription successful', {
      transcribedText: transcript,
      textLength: transcript.length,
      confidence: confidence,
      latency: latency,
      provider: 'deepgram-nova-3'
    });
    
    return transcript;
  } catch (error) {
    const errorInfo = {
      message: error.message,
      code: error.code,
      name: error.name
    };
    
    logger.error('🎤 [STT-ERROR] Deepgram transcription failed', {
      error: errorInfo,
      audioUrl: audioUrl ? audioUrl.substring(0, 100) + '...' : 'null'
    });
    return null;
  }
};

module.exports = {
  transcribeWithGroq, // Export Groq function
  transcribeWithDeepgram, // Export Deepgram function
  processTwilioSpeechResult,
  validateSpeechResult,
};
