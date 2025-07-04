/**
 * Main application for the AI Caller
 */
require('dotenv').config();
const express = require('express');
const scheduler = require('./services/scheduler');
const twilioWebhooks = require('./webhooks/twilioWebhooks');
const audioWebhooks = require('./webhooks/audioWebhooks');
const smsWebhook = require('./webhooks/smsWebhook');
const { processOnboardingQueue } = require('./services/smsHandler');
const logger = require('./utils/logger');
const path = require('path');
const fs = require('fs');
const contactMonitor = require('./services/contactMonitor');
const voiceMonitor = require('./utils/voiceMonitor');
const rateLimit = require('express-rate-limit');

// Create Express app
const app = express();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create cache directory if it doesn't exist
const cacheDir = path.join(__dirname, '..', 'public', 'tts-cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve cached TTS audio files
app.use('/tts-cache', express.static(cacheDir));

// Rate limiting
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per `window`
	standardHeaders: true,
	legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Register webhook routes
app.use('/api/calls', twilioWebhooks);
app.use('/api/calls/audio', audioWebhooks);
app.use('/webhooks', smsWebhook);

// Basic web interface for admin (optional)
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>AI Caller</title></head>
      <body><h1>AI Caller is running</h1></body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Monitoring Endpoint
app.get('/voice-metrics', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
     logger.warn('Attempted access to /voice-metrics in production');
     return res.status(403).json({ message: 'Access forbidden' });
  }
  try {
      const summary = voiceMonitor.getMetricsSummary();
      res.json(summary);
  } catch (error) {
      logger.error('Error retrieving voice metrics', { error: error.message });
      res.status(500).json({ message: 'Error retrieving metrics' });
  }
});

// Onboarding Management Endpoints
app.post('/api/onboarding/process', async (req, res) => {
  try {
    logger.info('Manual onboarding processing triggered');
    await processOnboardingQueue();
    res.json({ message: 'Onboarding queue processed successfully' });
  } catch (error) {
    logger.error('Error processing onboarding queue:', error);
    res.status(500).json({ message: 'Error processing onboarding queue', error: error.message });
  }
});

app.get('/api/onboarding/status', (req, res) => {
  res.json({ 
    message: 'Onboarding system is running',
    timestamp: new Date().toISOString()
  });
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
    // Supabase client initializes itself; no explicit connect call needed.
    app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`);
    });
    
    if (process.env.DISABLE_SCHEDULER !== 'true') {
      // Schedule both phone calls and onboarding processing
      const jobs = scheduler.scheduleAllTasks();
      logger.info('All automated tasks scheduled', {
        callJob: !!jobs.callJob,
        onboardingJob: !!jobs.onboardingJob
      });
    } else {
      logger.info('Automatic scheduler is disabled');
    }
    
    // Start onboarding queue processing
    if (process.env.DISABLE_ONBOARDING !== 'true') {
      logger.info('Starting onboarding queue processor');
      // Process onboarding queue on startup
      processOnboardingQueue().catch(error => {
        logger.error('Error during initial onboarding queue processing:', error);
      });
      
      // Process onboarding queue every 2 minutes
      setInterval(async () => {
        try {
          await processOnboardingQueue();
        } catch (error) {
          logger.error('Error in periodic onboarding queue processing:', error);
        }
      }, 2 * 60 * 1000); // 2 minutes
    } else {
      logger.info('Onboarding queue processing is disabled');
    }
    
    logger.info('AI Caller application started successfully');
    
    contactMonitor.startWatcher();

  } catch (error) {
    logger.error('Failed to start application', error);
    contactMonitor.stopWatcher(); 
    process.exit(1);
  }
};

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
  logger.info(`${signal} signal received. Shutting down gracefully...`);
  contactMonitor.stopWatcher(true);
  // No database.disconnect() needed for Supabase
  logger.info('Exiting process.');
  process.exit(0);
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
