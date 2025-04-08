const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Schema for storing structured founder preferences regarding investors,
 * typically extracted from call transcripts.
 */
const FounderPreferenceSchema = new Schema({
  contactId: {
    type: Schema.Types.ObjectId,
    ref: 'Contact',
    required: true,
    index: true
  },
  callSid: {
    type: String,
    required: true,
    unique: true, // Ensure only one preference record per call
    index: true
  },
  
  // --- Structured Preferences ---
  investmentStage: {
    type: [String],
    // Example enum, adjust as needed
    enum: ['pre-seed', 'seed', 'Series A', 'Series B', 'growth', 'late stage', 'all stages', 'unknown'], 
    default: [] 
  },
  industryExpertise: {
    type: [String],
    default: []
  },
  investmentSize: {
    min: { type: Number },
    max: { type: Number },
    currency: { type: String, default: 'USD' },
    description: { type: String } // e.g., "$500k - $1M", "around $2 million"
  },
  valueAdds: {
    type: [String],
    // Example enum, adjust as needed
    enum: ['network', 'connections', 'domain expertise', 'operational', 'strategic', 'marketing', 'sales', 'technical', 'recruiting', 'international expansion', 'fundraising help', 'board seat', 'mentorship', 'other'],
    default: []
  },
  geographicPreference: {
    type: [String], // e.g., "SF Bay Area", "West Coast", "US-based", "Global"
    default: []
  },
  firmTypes: {
    type: [String],
    enum: ['VC firm', 'angel investor', 'angel group', 'family office', 'corporate VC', 'accelerator', 'incubator', 'fund of funds', 'other'],
    default: []
  },
  engagementStyle: {
    type: String,
    enum: ['hands-on', 'involved', 'balanced', 'supportive', 'hands-off', 'strategic only', 'unknown'],
    default: 'unknown'
  },
  admiredInvestors: { // Names of investors or firms they admire
    type: [String],
    default: []
  },
  
  // --- Raw & Analyzed Data ---
  fullTranscript: {
    type: String
  },
  keyInsights: { // Key takeaways or summary points from analysis
    type: [String],
    default: []
  },
  
  // --- Metadata ---
  callDate: {
    type: Date,
    default: Date.now
  },
  callDuration: { // In seconds
    type: Number, 
    default: 0
  },
  analysisStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
    index: true
  }
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Optional: Add compound index if needed for frequent queries
// FounderPreferenceSchema.index({ contactId: 1, callDate: -1 });

module.exports = mongoose.model('FounderPreference', FounderPreferenceSchema);
