/**
 * Main application for Foundess Caller
 */
require('dotenv').config();
const express = require('express');
const database = require('./services/database');
const scheduler = require('./services/scheduler');
const twilioWebhooks = require('./webhooks/twilioWebhooks');
const logger = require('./utils/logger');
const path = require('path');
const fs = require('fs');
const contactMonitor = require('./services/contactMonitor');

// Create Express app
const app = express();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validate Twilio requests (uncomment and configure in production)
/*
const validateRequest = require('./middlewares/validateTwilioRequest');
app.use('/api/calls', validateRequest);
*/

// Register webhook routes
app.use('/api/calls', twilioWebhooks);

// Basic web interface for admin (optional)
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Foundess Caller</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          .status { padding: 10px; background: #f0f0f0; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <h1>Foundess Caller</h1>
        <div class="status">
          <p>Server is running and ready to process calls.</p>
          <p>Current time: ${new Date().toLocaleString()}</p>
        </div>
        <div class="footer">
          <p>Foundess Caller v1.0</p>
        </div>
      </body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled application error', { error: err });
  res.status(500).send('Internal Server Error');
});

// Start the server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Connect to MongoDB
    await database.connectToDatabase();
    
    // Start the HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`);
    });
    
    // Schedule automatic calls (unless disabled in environment)
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      scheduler.schedulePhoneCalls();
    } else {
      logger.info('Automatic call scheduler is disabled');
    }
    
    logger.info('Foundess Caller application started successfully');
    
    // Start the contact monitor service AFTER DB connection and server start
    logger.info('Attempting to initialize contact monitor...');
    contactMonitor.startWatcher(); // Call the enhanced start function

  } catch (error) {
    logger.error('Failed to start application', error);
    // Ensure monitor is stopped if startup fails after it might have started
    contactMonitor.stopWatcher(); 
    process.exit(1);
  }
};

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
  logger.info(`${signal} signal received. Shutting down gracefully...`);
  contactMonitor.stopWatcher(true); // Ensure restart timeout is cleared on shutdown
  // Add server closing logic if needed (e.g., server.close(() => ...))
  database.disconnect() // Assuming you add a disconnect function to database.js
    .then(() => logger.info('MongoDB connection closed.'))
    .catch(err => logger.error('Error closing MongoDB connection', err))
    .finally(() => process.exit(0));
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Handle Ctrl+C

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
