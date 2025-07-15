/**
 * Sentence Completion Detector for LLM Early Cutoff
 * 
 * Detects when the AI has completed a meaningful response that serves the current intent,
 * allowing for early termination of token generation to reduce latency.
 */

const logger = require('./logger');

/**
 * Microsoft Support specific completion patterns
 * These represent complete conversational turns that don't need additional text
 */
const MICROSOFT_SUPPORT_PATTERNS = [
  // Questions that are complete
  {
    pattern: /Are you (?:the )?(?:main )?(?:computer )?(?:owner|user)\?/i,
    type: 'question',
    description: 'Computer ownership verification question'
  },
  {
    pattern: /(?:Can you|Could you) (?:please )?(?:go to|open|check|look at) (?:your )?computer\?/i,
    type: 'question', 
    description: 'Computer access request'
  },
  {
    pattern: /(?:Do you|Have you) (?:have )?(?:a )?(?:credit card|payment method)\?/i,
    type: 'question',
    description: 'Payment method inquiry'
  },
  {
    pattern: /What (?:is )?(?:your )?(?:name|address|phone number)\?/i,
    type: 'question',
    description: 'Personal information request'
  },
  
  // Complete statements/declarations
  {
    pattern: /(?:We|Our servers) (?:have )?detected (?:a )?(?:dangerous |malicious )?virus (?:on your computer)?\.?/i,
    type: 'statement',
    description: 'Virus detection claim'
  },
  {
    pattern: /(?:You need|I need you) to (?:purchase|buy) (?:our )?(?:network security )?firewall\.?/i,
    type: 'statement',
    description: 'Firewall purchase statement'
  },
  {
    pattern: /(?:This|That) (?:will )?(?:cost|costs) \$[\d,]+\.?/i,
    type: 'statement',
    description: 'Price statement'
  },
  {
    pattern: /(?:Please|I need) (?:your )?(?:credit card )?(?:number|information)\.?/i,
    type: 'statement',
    description: 'Credit card request'
  },
  
  // Instructions that are complete
  {
    pattern: /(?:Please|I need you to) (?:go to|open|check) (?:your )?(?:computer|browser|settings)\.?/i,
    type: 'instruction',
    description: 'Computer access instruction'
  },
  {
    pattern: /(?:Call|Contact) (?:me|us) (?:back )?at [\d\-\(\)\s]+\.?/i,
    type: 'instruction',
    description: 'Callback instruction'
  },
  
  // Responses to user confusion/denial
  {
    pattern: /(?:I understand|I know) (?:this )?(?:may )?(?:sound|seem) (?:confusing|suspicious|strange)\.?/i,
    type: 'response',
    description: 'Acknowledgment of user concern'
  },
  {
    pattern: /(?:This is|I am) (?:a )?legitimate (?:call|service) from Microsoft\.?/i,
    type: 'response',
    description: 'Legitimacy assertion'
  }
];

/**
 * Generic completion patterns that work across different personas
 */
const GENERIC_COMPLETION_PATTERNS = [
  // Complete questions
  {
    pattern: /\b(?:what|who|where|when|why|how|which|whose)\b.*\?$/i,
    type: 'question',
    description: 'Wh-question'
  },
  {
    pattern: /\b(?:can|could|will|would|should|may|might|do|does|did|are|is|am|have|has|had)\b.*\?$/i,
    type: 'question', 
    description: 'Yes/no question'
  },
  
  // Complete sentences with strong endings
  {
    pattern: /\.$/,
    type: 'statement',
    description: 'Statement ending with period'
  },
  {
    pattern: /!$/,
    type: 'exclamation',
    description: 'Exclamatory statement'
  },
  
  // Direct address/greeting completions
  {
    pattern: /\b(?:hello|hi|good morning|good afternoon|good evening)\b.*\.?$/i,
    type: 'greeting',
    description: 'Greeting'
  },
  {
    pattern: /\b(?:thank you|thanks|goodbye|bye|see you)\b.*\.?$/i,
    type: 'closing',
    description: 'Conversation closing'
  }
];

/**
 * Analyzes text to determine if it represents a complete conversational turn
 * @param {string} text - The text to analyze
 * @param {string} persona - The AI persona (default: 'microsoft_support')
 * @returns {Object} Analysis result with completion status and details
 */
function analyzeCompletion(text, persona = 'microsoft_support') {
  if (!text || typeof text !== 'string') {
    return { isComplete: false, reason: 'Empty or invalid text' };
  }
  
  const trimmedText = text.trim();
  if (trimmedText.length < 3) {
    return { isComplete: false, reason: 'Text too short' };
  }
  
  // Check persona-specific patterns first
  if (persona === 'microsoft_support') {
    for (const patternInfo of MICROSOFT_SUPPORT_PATTERNS) {
      if (patternInfo.pattern.test(trimmedText)) {
        return {
          isComplete: true,
          reason: `Microsoft Support pattern matched: ${patternInfo.description}`,
          type: patternInfo.type,
          pattern: patternInfo.description,
          confidence: 0.9
        };
      }
    }
  }
  
  // Check generic completion patterns
  for (const patternInfo of GENERIC_COMPLETION_PATTERNS) {
    if (patternInfo.pattern.test(trimmedText)) {
      return {
        isComplete: true,
        reason: `Generic pattern matched: ${patternInfo.description}`,
        type: patternInfo.type,
        pattern: patternInfo.description,
        confidence: 0.7
      };
    }
  }
  
  // Additional heuristics for completion
  const wordCount = trimmedText.split(/\s+/).length;
  
  // Very long responses are probably complete thoughts
  if (wordCount >= 20) {
    return {
      isComplete: true,
      reason: 'Long response likely complete',
      type: 'heuristic',
      confidence: 0.6
    };
  }
  
  // Short responses with conjunctions suggest more content coming
  if (wordCount < 8 && /\b(?:and|but|or|so|however|also|additionally)\b/i.test(trimmedText)) {
    return {
      isComplete: false,
      reason: 'Conjunction suggests continuation',
      confidence: 0.8
    };
  }
  
  return { isComplete: false, reason: 'No completion pattern matched' };
}

/**
 * Determines if text generation should be cut off early
 * @param {string} currentText - The text generated so far
 * @param {string} latestChunk - The most recent chunk received
 * @param {Object} options - Configuration options
 * @returns {Object} Decision on whether to cut off generation
 */
function shouldCutOffGeneration(currentText, latestChunk, options = {}) {
  const {
    persona = 'microsoft_support',
    minLength = 10,
    maxLength = 200,
    enableEarlyCutoff = true
  } = options;
  
  if (!enableEarlyCutoff) {
    return { shouldCutOff: false, reason: 'Early cutoff disabled' };
  }
  
  // Don't cut off very short responses
  if (currentText.length < minLength) {
    return { shouldCutOff: false, reason: 'Response too short' };
  }
  
  // Cut off extremely long responses
  if (currentText.length > maxLength) {
    return { 
      shouldCutOff: true, 
      reason: 'Response exceeded maximum length',
      type: 'length_limit'
    };
  }
  
  // Analyze completion after each sentence-ending chunk
  if (/[.!?]/.test(latestChunk)) {
    const analysis = analyzeCompletion(currentText, persona);
    
    if (analysis.isComplete && analysis.confidence >= 0.7) {
      logger.info('Early cutoff triggered', {
        reason: analysis.reason,
        type: analysis.type,
        confidence: analysis.confidence,
        textLength: currentText.length,
        textPreview: currentText.substring(0, 100)
      });
      
      return {
        shouldCutOff: true,
        reason: analysis.reason,
        type: analysis.type,
        confidence: analysis.confidence,
        analysis
      };
    }
  }
  
  return { shouldCutOff: false, reason: 'Generation should continue' };
}

/**
 * Pre-validates if early cutoff is appropriate for the given context
 * @param {string} userInput - The user's input that triggered the response
 * @param {Array} conversationHistory - Recent conversation history
 * @returns {boolean} Whether early cutoff should be enabled for this response
 */
function shouldEnableEarlyCutoffForContext(userInput, conversationHistory = []) {
  // Don't use early cutoff for confusion/clarification requests
  const confusionPatterns = [
    /what\?/i, /pardon/i, /repeat/i, /didn't\s+(hear|catch)/i,
    /say\s+that\s+again/i, /confused/i, /don't\s+understand/i
  ];
  
  if (confusionPatterns.some(pattern => pattern.test(userInput))) {
    return false;
  }
  
  // Don't use early cutoff for very complex or specific questions
  if (userInput.includes('?') && userInput.length > 50) {
    return false;
  }
  
  return true;
}

module.exports = {
  analyzeCompletion,
  shouldCutOffGeneration,
  shouldEnableEarlyCutoffForContext,
  MICROSOFT_SUPPORT_PATTERNS,
  GENERIC_COMPLETION_PATTERNS
};