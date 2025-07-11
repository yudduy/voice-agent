/**
 * Twilio Media Streams Webhook Handler
 * * Establishes and manages WebSocket connections for real-time, bidirectional audio streaming.
 */

const express = require('express');
const router = express.Router();
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const WebSocket = require('ws');
const logger = require('../utils/logger');
// DO NOT require the orchestrator at the top level to prevent circular dependencies.
const userRepository = require('../repositories/userRepository');
const conversationService = require('../services/conversation');

// Store active orchestrators, mapping callSid to orchestrator instance.
const activeOrchestrators = new Map();

/**
 * Handles the initial call connection from Twilio.
 * Its only job is to return TwiML that tells Twilio to start a media stream.
 */
router.post('/connect', async (req, res) => {
  const { CallSid: callSid, From: fromNumber, To: toNumber } = req.body;
  const response = new VoiceResponse();

  try {
    logger.info('📞 [Media Stream] New call connection request', { callSid, fromNumber, toNumber });

    const user = await userRepository.findUserByPhoneNumber(fromNumber) || await userRepository.createGuestUser(fromNumber);

    await conversationService.initializeConversation(callSid, { _id: user.id });

    // Determine the correct WebSocket protocol (wss for secure/ngrok, ws for local).
    const host = req.get('host');
    const protocol = (req.secure || host.includes('ngrok')) ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}/media-stream/${callSid}`;

    // Instruct Twilio to connect to our WebSocket server.
    // CRITICAL FIX: The 'track' attribute is invalid for bidirectional <Connect><Stream>
    // and was causing Twilio to silently fail. It has been removed.
    const connect = response.connect();
    const stream = connect.stream({
      url: wsUrl
    });
    
    // Pass user details as custom parameters, which Twilio sends as headers.
    stream.parameter({ name: 'userId', value: user.id });
    stream.parameter({ name: 'userName', value: user.name || 'Guest' });

    logger.info('🎙️ [Media Stream] Generated TwiML to initiate WebSocket connection', { callSid, wsUrl });

    const twimlResponse = response.toString();
    logger.debug('📄 [Media Stream] TwiML Response', { twiml: twimlResponse });

    res.type('text/xml').send(twimlResponse);

  } catch (error) {
    logger.error('❌ [Media Stream Connect Error]', { callSid, error: error.message, stack: error.stack });
    const fallbackResponse = new VoiceResponse();
    fallbackResponse.say("We're sorry, an error occurred. Please try your call again later.");
    fallbackResponse.hangup();
    res.type('text/xml').send(fallbackResponse.toString());
  }
});

/**
 * Handles call status updates. Crucial for resource cleanup.
 */
router.post('/status', (req, res) => {
  const { CallSid: callSid, CallStatus: status } = req.body;
  logger.info(`📊 [Media Stream Status] CallSid: ${callSid}, Status: ${status}`);

  if (['completed', 'failed', 'busy', 'no-answer'].includes(status)) {
    const orchestrator = activeOrchestrators.get(callSid);
    if (orchestrator) {
      orchestrator.cleanup();
      activeOrchestrators.delete(callSid);
      logger.info(`🧹 [Media Stream] Orchestrator cleaned up for CallSid: ${callSid}`);
    }
  }
  res.sendStatus(200);
});

/**
 * WebSocket upgrade handler. This is the entry point for real-time communication.
 */
function handleWebSocketUpgrade(server) {
  const wss = new WebSocket.Server({ noServer: true });
  
  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;
    const match = pathname.match(/^\/media-stream\/(CA[a-f0-9]{32})$/);
    
    if (match) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      logger.warn(`❌ [WebSocket] Invalid upgrade path: ${pathname}. Destroying socket.`);
      socket.destroy();
    }
  });

  wss.on('connection', async (ws, request) => {
    // CRITICAL FIX: Require the orchestrator here, inside the connection handler,
    // and use destructuring for the named export. This breaks the circular dependency.
    const { WebSocketOrchestrator } = require('../services/websocketOrchestrator');

    const pathname = request.url;
    const match = pathname.match(/^\/media-stream\/(CA[a-f0-9]{32})$/);
    if (!match) {
        logger.error(`❌ [WebSocket] Connection established but path is now invalid: ${pathname}. Closing.`);
        ws.close(1011, "Invalid Path");
        return;
    }
    const callSid = match[1];
    const userId = request.headers['x-twilio-param-userid'];
    
    logger.info(`🔌 [WebSocket] New connection established for CallSid: ${callSid}`, { userId });

    try {
      const orchestrator = new WebSocketOrchestrator(callSid, userId);
      activeOrchestrators.set(callSid, orchestrator);
      
      orchestrator.handleTwilioConnection(ws);

      orchestrator.on('call_ended', () => {
        activeOrchestrators.delete(callSid);
      });
    } catch (error) {
      logger.error('❌ [WebSocket] Error creating orchestrator', { callSid, error: error.message, stack: error.stack });
      ws.close(1011, 'Orchestrator setup failed');
    }
  });

  logger.info('🔧 [WebSocket] Upgrade handler is configured and ready.');
  return wss;
}

module.exports = {
  router,
  handleWebSocketUpgrade
};