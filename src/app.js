/**
 * Main application for the AI Caller
 */
require('dotenv').config();
const express = require('express');
const http = require('http'); // CRITICAL: Import http module for proper server creation
const scheduler = require('./services/scheduler');
const unifiedTwilioWebhooks = require('./webhooks/unifiedTwilioWebhooks');
const audioWebhooks = require('./webhooks/audioWebhooks');
const smsWebhook = require('./webhooks/smsWebhook');
const { router: mediaStreamRouter, handleWebSocketUpgrade } = require('./webhooks/mediaStreamWebhook');
const { processOnboardingQueue } = require('./services/smsHandler');
const logger = require('./utils/logger');
const path = require('path');
const fs = require('fs');
const voiceMonitor = require('./utils/voiceMonitor');
const rateLimit = require('express-rate-limit');
const { performance: performanceConfig } = require('./config');
const { featureFlags, logFeatureFlags } = require('./config/featureFlags');
const connectionPool = require('./services/connectionPool');
const ffmpegPool = require('./services/ffmpegPool');
const audioCache = require('./services/audioCache');

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

// Trust proxy for ngrok/reverse proxy setups
// Use 1 to trust only the first proxy (ngrok)
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve cached TTS audio files
app.use('/tts-cache', express.static(cacheDir));

// Rate limiting
const apiLimiter = rateLimit({
	windowMs: performanceConfig.rateLimit.windowMs,
	max: performanceConfig.rateLimit.maxRequests,
	standardHeaders: true,
	legacyHeaders: false,
	handler: (req, res) => {
		logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
		res.status(429).json({ error: 'Too many requests' });
	},
	skip: (req) => {
		// Skip rate limiting for localhost in development
		return process.env.NODE_ENV !== 'production' && req.ip === '::1';
	}
});
app.use('/api/', apiLimiter);

// Register webhook routes based on streaming preference
if (process.env.ENABLE_MEDIA_STREAMS === 'true') {
  logger.info('🚀 [App] Mounting Media Streams webhook for real-time processing with Deepgram STT');
  app.use('/api/media-stream', mediaStreamRouter);
  
  // Mount unified webhook with deprecation warning for backward compatibility
  app.use('/api/calls', (req, res, next) => {
    logger.warn('⚠️ [DEPRECATED] Call received on legacy unified webhook', {
      path: req.path,
      method: req.method,
      callSid: req.body?.CallSid
    });
    logger.warn('⚠️ [DEPRECATED] This endpoint will be removed. Please ensure all webhooks use /api/media-stream/*');
    next();
  }, unifiedTwilioWebhooks);
} else {
  logger.info('📦 [App] Using batch-processing webhooks');
  app.use('/api/calls', unifiedTwilioWebhooks);
}

// Always mount these routes
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
    
    // Log feature flags
    logFeatureFlags(logger);
    
    // Initialize optimization services based on feature flags
    logger.info('Initializing performance optimization services...');
    
    if (featureFlags.ENABLE_WEBSOCKET_POOLING) {
      await connectionPool.initialize();
      logger.info('WebSocket connection pool initialized');
    }
    
    if (featureFlags.ENABLE_FFMPEG_POOLING) {
      await ffmpegPool.initialize();
      logger.info('FFmpeg process pool initialized');
    }
    
    if (featureFlags.ENABLE_AUDIO_RESPONSE_CACHE) {
      await audioCache.initialize();
      logger.info('Audio response cache initialized');
    }
    
    // Create HTTP server instance first, but don't start listening yet
    const server = http.createServer(app);
    
    // Enable WebSocket upgrade handler BEFORE starting to listen
    // This prevents the race condition where Twilio might connect before handler is ready
    if (process.env.ENABLE_MEDIA_STREAMS === 'true') {
      handleWebSocketUpgrade(server);
      logger.info('🔌 [App] WebSocket upgrade handler attached for Media Streams');
      
      // Auto-configure Twilio webhooks for streaming mode
      const twilioWebhookManager = require('./services/twilioWebhookManager');
      twilioWebhookManager.autoConfigureWebhooks()
        .then(config => {
          if (config) {
            logger.info('🔗 [App] Twilio webhooks configured for streaming mode');
          }
        })
        .catch(err => {
          logger.warn('⚠️ [App] Could not auto-configure Twilio webhooks', { error: err.message });
        });
    }
    
    // NOW start listening for connections after all handlers are attached
    server.listen(PORT, () => {
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
    
  } catch (error) {
    logger.error('Failed to start application', error);
    process.exit(1);
  }
};

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
  logger.info(`${signal} signal received. Shutting down gracefully...`);
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
