/**
 * Contact model that mirrors the Slack bot's contact structure
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ContactSchema = new Schema({
  userId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  },
  email: {
    type: String
  },
  slackTeamId: {
    type: String
  },
  channel: {
    type: String
  },
  status: {
    type: String,
    default: 'new'
  },
  callStatus: {
    type: String,
    enum: ['pending', 'initiated', 'in-progress', 'completed', 'failed', null],
    default: 'pending'
  },
  lastCallSid: {
    type: String
  },
  lastCallTime: {
    type: Date
  },
  callCount: {
    type: Number,
    default: 0
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
  },
  // Fields for Contact Monitor Service
  monitorStatus: {
    type: String,
    enum: ['pending', 'processing', 'processed', 'error', null],
    default: 'pending',
    index: true // Index for efficient querying by monitorStatus
  },
  monitorProcessedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Set up existing collection name to match the Slack bot's collection
// Ensure this matches the actual collection name in MongoDB
module.exports = mongoose.model('Contact', ContactSchema, 'contacts');
