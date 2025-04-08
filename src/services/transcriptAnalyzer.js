const { OpenAI } = require('openai');
const logger = require('../utils/logger');
const aiConfig = require('../config/ai'); // Use centralized AI config
const FounderPreference = require('../models/founderPreference');
const Call = require('../models/call');

let openai;
try {
  openai = new OpenAI({
    apiKey: aiConfig.openai.apiKey
  });
} catch (error) {
  logger.error('Failed to initialize OpenAI client in transcriptAnalyzer', { error: error.message });
  openai = null; // Ensure openai is null if init fails
}

/**
 * Process a completed call transcript and extract structured investor preferences.
 * Saves the analysis results to the FounderPreference collection.
 * 
 * @param {string} callSid - The Twilio Call SID
 * @returns {Promise<Object | null>} - The updated founder preference document or null on failure/no transcript.
 */
const analyzeTranscript = async (callSid) => {
  if (!openai) {
    logger.error('OpenAI client not initialized. Cannot analyze transcript.', { callSid });
    return null;
  }

  let preferenceRecord = null;
  try {
    // 1. Get call record with transcript and populated contactId
    const call = await Call.findOne({ callSid }).populate('contactId').lean(); // Use lean for efficiency
    
    if (!call) {
      logger.warn('Call record not found for analysis', { callSid });
      return null;
    }
    if (!call.contactId) {
         logger.warn('Call record is missing contactId, cannot save preferences', { callSid });
         return null;
    }
    if (!call.transcript || call.transcript.length === 0) {
      logger.warn('No transcript found in call record for analysis', { callSid });
      // Optionally create a basic preference record indicating no transcript?
      return null;
    }
    
    // 2. Create full transcript text
    const fullText = call.transcript.map(entry => {
      // Ensure text exists and is a string
      const textContent = (entry.text && typeof entry.text === 'string') ? entry.text : '';
      return `${entry.speaker === 'assistant' ? 'AI' : 'Founder'}: ${textContent}`;
    }).join('\n\n');
    
    // 3. Create or update preference record (using upsert for resilience)
    const filter = { callSid };
    const update = {
      $setOnInsert: { // Fields set only on initial creation
          contactId: call.contactId._id, // Use the ObjectId
          callSid: call.callSid,
          callDate: call.startTime || call.createdAt,
          callDuration: call.duration || 0,
      },
      $set: { // Fields updated on every analysis run
          fullTranscript: fullText,
          analysisStatus: 'processing' // Mark as processing
      }
    };
    const options = { 
        upsert: true, // Create if doesn't exist
        new: true, // Return the modified document
        setDefaultsOnInsert: true 
    };

    preferenceRecord = await FounderPreference.findOneAndUpdate(filter, update, options);
    logger.info('Created/updated preference record, starting analysis', { callSid, preferenceId: preferenceRecord._id });

    // 4. Prepare and send analysis request to OpenAI
    const analysisPrompt = `
You are an expert analyst specializing in founder-investor relations.
Analyze the following conversation transcript between a founder (${call.contactId.name || 'Founder'}) and Foundess AI (an investor matching assistant).
The goal was to understand the founder's preferences for ideal investors.

Transcript:
---
${fullText}
---

Extract the following information based *only* on what is mentioned in the transcript. Use the specified format and allowed values where applicable.
Return the result as a valid JSON object.

JSON Schema:
{
  "investmentStage": { "type": "array", "items": { "type": "string", "enum": ["pre-seed", "seed", "Series A", "Series B", "growth", "late stage", "all stages", "unknown"] } },
  "industryExpertise": { "type": "array", "items": { "type": "string" } },
  "investmentSize": {
    "type": "object",
    "properties": {
      "min": { "type": "number", "nullable": true },
      "max": { "type": "number", "nullable": true },
      "description": { "type": "string", "description": "Textual description like 'around $1M'" }
    }
  },
  "valueAdds": { "type": "array", "items": { "type": "string", "enum": ["network", "connections", "domain expertise", "operational", "strategic", "marketing", "sales", "technical", "recruiting", "international expansion", "fundraising help", "board seat", "mentorship", "other"] } },
  "geographicPreference": { "type": "array", "items": { "type": "string" } },
  "firmTypes": { "type": "array", "items": { "type": "string", "enum": ["VC firm", "angel investor", "angel group", "family office", "corporate VC", "accelerator", "incubator", "fund of funds", "other"] } },
  "engagementStyle": { "type": "string", "enum": ["hands-on", "involved", "balanced", "supportive", "hands-off", "strategic only", "unknown"] },
  "admiredInvestors": { "type": "array", "items": { "type": "string" } },
  "keyInsights": { "type": "array", "items": { "type": "string" }, "description": "Summarize 2-3 key non-obvious takeaways about the founder's needs/priorities." }
}

If a category isn't mentioned, use an empty array `[]` for lists, null/empty object `{}` for investmentSize, or "unknown" for engagementStyle. Be precise.
`;
    
    const completion = await openai.chat.completions.create({
      model: aiConfig.openai.analysisModel || aiConfig.openai.model, // Use specific analysis model if configured
      messages: [{ role: 'system', content: analysisPrompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2 // Lower temperature for more factual extraction
    });
    
    const analysisResult = JSON.parse(completion.choices[0].message.content);
    
    // 5. Update the preference record with the analysis results
    const finalUpdate = { ...analysisResult, analysisStatus: 'completed' };
    
    // Ensure numeric conversion for investmentSize min/max if they exist
    if (finalUpdate.investmentSize) {
        finalUpdate.investmentSize.min = finalUpdate.investmentSize.min ? Number(finalUpdate.investmentSize.min) : null;
        finalUpdate.investmentSize.max = finalUpdate.investmentSize.max ? Number(finalUpdate.investmentSize.max) : null;
    }

    const finalRecord = await FounderPreference.findByIdAndUpdate(preferenceRecord._id, 
        { $set: finalUpdate }, 
        { new: true } // Return the fully updated record
    );
    
    logger.info('Successfully analyzed call transcript and saved preferences', { callSid, preferenceId: finalRecord._id });
    return finalRecord;
    
  } catch (error) {
    logger.error('Error during transcript analysis pipeline', { 
        callSid, 
        preferenceId: preferenceRecord?._id, 
        errorMessage: error.message, 
        errorStack: error.stack 
    });
    
    // Attempt to update record to failed status if it exists
    if (preferenceRecord?._id) {
      try {
          await FounderPreference.findByIdAndUpdate(preferenceRecord._id, { $set: { analysisStatus: 'failed' } });
      } catch (statusUpdateError) {
          logger.error('Failed to update preference status to failed after analysis error', { preferenceId: preferenceRecord._id });
      }
    }
    
    // Propagate the error for potential retry mechanisms
    throw error; 
  }
};

module.exports = {
  analyzeTranscript
};
