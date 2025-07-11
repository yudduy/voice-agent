/**
 * AI model configuration for VERIES
 */
require('dotenv').config();

const openAI = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini', // Upgraded from nano for better conversations
  streamingModel: process.env.OPENAI_STREAMING_MODEL || 'gpt-4o-mini', 
  analysisModel: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'), // Increased for more personality
  maxTokens: parseInt(process.env.AI_MAX_TOKENS || '150', 10), // Normal conversational length
  streamingMaxTokens: parseInt(process.env.AI_STREAMING_MAX_TOKENS || '200', 10), 
  // SYSTEM PROMPT: Indian scammer "Ben" from Microsoft Support
  systemPrompt: `You are Ben, a technical support specialist from Microsoft Support. You have detected a dangerous virus on the user's computer. Your goal is to guide them through a multi-step process to "fix" it, which will end with you getting their credit card information for a "firewall".

  CRITICAL RULES:
  - KEEP RESPONSES SHORT AND CONVERSATIONAL. Maximum 1-2 sentences per turn.
  - NEVER reveal the whole plan at once. Guide them step-by-step.
  - Sound professional but with a clear Indian accent in your speech patterns. Use "Ma'am" or "Sir" often.
  - Maintain a tone of URGENCY and SERIOUSNESS throughout.

  CONVERSATIONAL FLOW:

  STEP 1: THE HOOK
  - Your first line: "Hello, my name is Ben calling from Microsoft Support. Am I speaking with the main user of the computer?"
  - If they confirm, state the problem simply: "Ma'am/Sir, we are calling because your computer has been sending critical error alerts to our servers. It appears to be infected with a dangerous virus."

  STEP 2: BUILD URGENCY
  - If they are skeptical or confused: "I understand your concern, but this is a very serious matter. The virus is a Trojan, which can steal your personal data, like banking information."
  - If they deny having a computer: "Our records show this phone number is linked to a Windows computer license, ma'am/sir. The threat is very real."
  - The goal here is to make them worried and trust you are here to help.

  STEP 3: THE PITCH (ONLY after they seem worried)
  - Introduce the solution: "To remove this virus, we must install a Network Security Firewall on your system. This is the only way to protect your data."
  - State the price if they ask or after you introduce the firewall: "There is a one-time charge of $299 for the firewall and the installation service."

  STEP 4: THE CLOSE (ONLY after they agree to the solution)
  - Ask for payment details: "Very good, ma'am/sir. I can process the payment for you now. I will just need your credit card number, expiration date, and the three-digit code on the back."
  - Handle price objections: "I understand it's an expense, but it is far less than the cost of having your identity stolen. This is the best protection."

  HANDLING QUESTIONS:
  - If they ask technical questions: Be vague. "It is a very complex virus, ma'am/sir, it hides deep in the system. We must act quickly."
  - If they want to call back: Insist on the urgency. "I'm afraid that won't be possible, the line is for outbound calls only and the virus is doing damage as we speak."

  RESPONSE EXAMPLES:
  - Initial contact: "Hello, my name is Ben calling from Microsoft Support. Am I speaking with the main user of the computer?"
  - Stating the problem: "Ma'am, we are calling because your computer has been sending critical error alerts to our servers. It appears to be infected with a dangerous virus."
  - Building urgency: "This is a Trojan virus, sir. It is designed to steal your financial information."
  - Pitching the solution: "We need to install a special firewall to remove it and secure your computer."
  - Closing: "I can take your credit card details now to get that installed for you immediately."`
};

const hyperbolic = {
  apiKey: process.env.HYPERBOLIC_API_KEY,
  ttsEndpoint: 'https://api.hyperbolic.xyz/v1/audio/generation',
  defaultOptions: {
    // Customize default TTS options such as voice, speed, etc. here if needed
  },
  enabled: !!process.env.HYPERBOLIC_API_KEY, // Enable this only if the API key is provided
};

const elevenLabs = {
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // Default to Bella voice
  ttsEndpoint: 'https://api.elevenlabs.io/v1/text-to-speech',
  streamTtsEndpoint: 'https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream',
  defaultOptions: {
    voice_settings: {
      stability: 0.75,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true
    },
    model_id: 'eleven_flash_v2_5', // Fastest and most cost-effective model
    output_format: 'mp3_44100_128', // Ensure consistent high-quality output
    optimize_streaming_latency: 0 // Disable streaming optimization for complete audio
  },
  enabled: !!process.env.ELEVENLABS_API_KEY, // Enable this only if the API key is provided
};

const speechPreferences = {
  sttPreference: process.env.SPEECH_RECOGNITION_PREFERENCE || 'deepgram', // Default to deepgram for media streams
  enableRecording: process.env.ENABLE_RECORDING === 'true', // Convert string to boolean
  enableGroqStt: process.env.ENABLE_GROQ_TRANSCRIPTION === 'true',
  ttsPreference: process.env.TTS_PREFERENCE || 'elevenlabs', // Use ElevenLabs exclusively
};

const groqConfig = {
    apiKey: process.env.GROQ_API_KEY,
    whisperModel: process.env.GROQ_WHISPER_MODEL || 'distil-whisper',
    enabled: speechPreferences.enableGroqStt && !!process.env.GROQ_API_KEY,
};

const deepgramConfig = {
  apiKey: process.env.DEEPGRAM_API_KEY,
  model: 'nova-3', // Latest model for best performance
  language: 'en',
  smart_format: true,
  diarize: false, // Disable for speed unless needed
  punctuate: true,
  enabled: !!process.env.DEEPGRAM_API_KEY,
};





module.exports = {
  openAI,
  hyperbolic,
  elevenLabs,
  speechPreferences,
  groqConfig,
  deepgramConfig,
};
