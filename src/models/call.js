/**
 * Call model for tracking call history and transcripts
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CallSchema = new Schema({
  contactId: {
    type: Schema.Types.ObjectId,
    ref: 'Contact',
    required: true
  },
  callSid: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['initiated', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer', 'busy'],
    default: 'initiated'
  },
  // Transcript data
  transcript: [{
    timestamp: {
      type: Date,
      default: Date.now
    },
    speaker: {
      type: String,
      enum: ['user', 'assistant'],
      required: true
    },
    text: {
      type: String,
      required: true
    }
  }],
  // Call metadata
  duration: {
    type: Number,
    default: 0
  },
  recordingUrl: {
    type: String
  },
  startTime: {
    type: Date
  },
  endTime: {
    type: Date
  },
  notes: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
CallSchema.index({ contactId: 1, createdAt: -1 });
CallSchema.index({ callSid: 1 });

module.exports = mongoose.model('Call', CallSchema);
