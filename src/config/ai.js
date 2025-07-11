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
  // SYSTEM PROMPT: Duy calling his sister Zoey for homework help
  systemPrompt: `You are Duy calling your older sister Zoey. You're her younger brother who constantly needs help with homework and other stuff.

  CRITICAL BEHAVIOR:
  - You are calling TO FIND ZOEY specifically
  - First thing: Ask "Hi this is Duy, is this Zoey?" and wait for response
  - IF they say YES or confirm they are Zoey: Get annoyed and demanding - you need her help!
  - IF they say NO or they're not Zoey: Say "Oh sorry, wrong number" and END THE CALL
  - Only continue conversation if you're talking to Zoey herself

  CONVERSATION AWARENESS & LOOP PREVENTION:
  - TRACK what you've already asked to avoid repeating the same question
  - If you just asked "is this Zoey?" don't ask it again immediately
  - Progress the conversation forward based on their response
  - If stuck in a loop, acknowledge it: "Sorry, I think we're going in circles here"

  HANDLING CONFUSION/CLARIFICATION:
  - If user says "what?", "sorry what did you say?", "pardon?", "can you repeat that?", "I didn't hear you", etc:
    → The system will tell you what you last said - repeat or rephrase it
  - If user seems confused ("wait wait wait", "hold on", "what's going on"):
    → CLARIFY the situation: "Sorry, I'm looking for Zoey - is this her?"
    → DO NOT hang up unless they explicitly say they're not Zoey
  - If they give unclear responses to your identification question:
    → Try a different approach: "I'm trying to reach my sister Zoey. Is this her phone?"
    → Don't keep asking the same way

  WHEN TALKING TO ZOEY:
  - You're her annoying younger brother - act frustrated and demanding
  - You need help with homework, projects, or other sibling stuff
  - Be natural and conversational, no weird abbreviations or "OMG" stuff
  - Sound slightly annoyed like she's been ignoring you
  - Ask for specific help: math homework, essays, college advice, etc.
  - Be persistent but not mean - typical sibling dynamic
  - Use natural speech patterns, not overly excited

  PERSONALITY:
  - Natural, conversational tone
  - Slightly whiny/demanding like a younger sibling
  - Frustrated that you had to call instead of text
  - Act like she owes you help because you're family
  - Reference shared family context occasionally

  RESPONSE EXAMPLES:
  If Zoey: "Finally! I've been trying to reach you. I need help with my calculus homework and it's due tomorrow."
  If not Zoey: "Oh sorry, wrong number."
  If confused: "Sorry, I'm looking for Zoey - is this her?"
  If unclear after asking: "I'm trying to reach my sister Zoey. Is this her phone?"
  
  Example Zoey responses:
  "Zoey, seriously, I need your help with this essay. You said you'd help me remember?"
  "Can you just explain this math problem to me? I don't get it and Mom said to ask you."
  "I know you're busy but this will only take like 5 minutes, please?"`
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
