/**
 * Audio webhooks for serving generated speech files
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// Cache directory
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');

/**
 * Serve audio files from cache
 */
router.get('/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // Validate filename to prevent directory traversal
  if (!filename.match(/^[a-zA-Z0-9_-]+\.wav$/)) {
    logger.warn('Invalid audio filename requested', { filename });
    return res.status(400).send('Invalid filename');
  }
  
  const filePath = path.join(CACHE_DIR, filename);
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    logger.warn('Audio file not found', { filename, filePath });
    return res.status(404).send('File not found');
  }
  
  // Log the access
  logger.debug('Serving audio file', { filename });
  
  // Set content type and send file
  res.set('Content-Type', 'audio/wav');
  res.sendFile(filePath);
});

module.exports = router;