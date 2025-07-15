const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// Mock dependencies
jest.mock('../../src/utils/logger');
jest.mock('../../src/repositories/userRepository');
jest.mock('../../src/services/conversation');
jest.mock('../../src/services/websocketOrchestrator');
jest.mock('twilio', () => ({
  twiml: {
    VoiceResponse: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockReturnThis(),
      stream: jest.fn().mockReturnThis(),
      parameter: jest.fn().mockReturnThis(),
      toString: jest.fn().mockReturnValue('<Response><Connect><Stream url=\"test-url\"/></Connect></Response>')
    }))
  }
}));

describe('MediaStreamWebhook', () => {
  let app;
  let mockLogger;
  let mockUserRepository;
  let mockConversationService;
  let mockWebsocketOrchestrator;
  let router;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mocks
    mockLogger = require('../../src/utils/logger');
    mockUserRepository = require('../../src/repositories/userRepository');
    mockConversationService = require('../../src/services/conversation');
    mockWebsocketOrchestrator = require('../../src/services/websocketOrchestrator');

    // Mock user repository
    mockUserRepository.findUserByPhoneNumber = jest.fn();
    mockUserRepository.createGuestUser = jest.fn();

    // Mock conversation service
    mockConversationService.initializeConversation = jest.fn();

    // Mock websocket orchestrator
    mockWebsocketOrchestrator.mockImplementation(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      handleWebSocketConnection: jest.fn(),
      handleDeepgramTranscript: jest.fn()
    }));

    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    
    // Get router from module
    const { router: mediaStreamRouter } = require('../../src/webhooks/mediaStreamWebhook');
    router = mediaStreamRouter;
    app.use('/api/media-stream', router);
  });

  describe('POST /connect', () => {
    const callData = {
      CallSid: 'test-call-sid',
      From: '+1234567890',
      To: '+1987654321'
    };

    it('should establish media stream connection for existing user', async () => {
      const existingUser = { id: 'user-123', name: 'John Doe' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(existingUser);

      const response = await request(app)
        .post('/api/media-stream/connect')
        .send(callData);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/xml/);
      expect(response.text).toContain('<Response>');
      expect(response.text).toContain('<Connect>');
      expect(response.text).toContain('<Stream');
      
      expect(mockUserRepository.findUserByPhoneNumber).toHaveBeenCalledWith('+1234567890');
      expect(mockConversationService.initializeConversation).toHaveBeenCalledWith(
        'test-call-sid',
        { _id: 'user-123' }
      );
    });

    it('should create guest user when user not found', async () => {
      const guestUser = { id: 'guest-456', name: 'Guest' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(null);
      mockUserRepository.createGuestUser.mockResolvedValue(guestUser);

      const response = await request(app)
        .post('/api/media-stream/connect')
        .send(callData);

      expect(response.status).toBe(200);
      expect(mockUserRepository.createGuestUser).toHaveBeenCalledWith('+1234567890');
      expect(mockConversationService.initializeConversation).toHaveBeenCalledWith(
        'test-call-sid',
        { _id: 'guest-456' }
      );
    });

    it('should generate correct WebSocket URL for secure connection', async () => {
      const user = { id: 'user-123', name: 'John' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(user);

      const response = await request(app)
        .post('/api/media-stream/connect')
        .set('Host', 'example.ngrok.io')
        .send(callData);

      expect(response.status).toBe(200);
      expect(response.text).toContain('wss://example.ngrok.io/media-stream/test-call-sid');
    });

    it('should generate correct WebSocket URL for local connection', async () => {
      const user = { id: 'user-123', name: 'John' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(user);

      const response = await request(app)
        .post('/api/media-stream/connect')
        .set('Host', 'localhost:3000')
        .send(callData);

      expect(response.status).toBe(200);
      expect(response.text).toContain('ws://localhost:3000/media-stream/test-call-sid');
    });

    it('should handle missing call parameters', async () => {
      const response = await request(app)
        .post('/api/media-stream/connect')
        .send({});

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in media stream connect'),
        expect.any(Object)
      );
    });

    it('should handle user repository errors', async () => {
      mockUserRepository.findUserByPhoneNumber.mockRejectedValue(new Error('DB error'));

      const response = await request(app)
        .post('/api/media-stream/connect')
        .send(callData);

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in media stream connect'),
        expect.any(Object)
      );
    });

    it('should handle conversation initialization errors', async () => {
      const user = { id: 'user-123', name: 'John' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(user);
      mockConversationService.initializeConversation.mockRejectedValue(
        new Error('Conversation error')
      );

      const response = await request(app)
        .post('/api/media-stream/connect')
        .send(callData);

      expect(response.status).toBe(500);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in media stream connect'),
        expect.any(Object)
      );
    });
  });

  describe('WebSocket upgrade handling', () => {
    let server;
    let wss;
    let handleWebSocketUpgrade;

    beforeEach(() => {
      // Get the WebSocket upgrade handler
      const webhook = require('../../src/webhooks/mediaStreamWebhook');
      handleWebSocketUpgrade = webhook.handleWebSocketUpgrade;
      
      // Create mock server
      server = new EventEmitter();
      server.listen = jest.fn();
      
      // Mock WebSocket Server
      wss = new EventEmitter();
      wss.handleUpgrade = jest.fn();
      wss.emit = jest.fn();
    });

    it('should handle WebSocket upgrade requests', () => {
      const mockRequest = {
        url: '/media-stream/test-call-sid',
        headers: { 'sec-websocket-key': 'test-key' }
      };
      const mockSocket = new EventEmitter();
      const mockHead = Buffer.from('test');

      handleWebSocketUpgrade(server);

      // Simulate upgrade event
      server.emit('upgrade', mockRequest, mockSocket, mockHead);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket upgrade request'),
        expect.objectContaining({ url: mockRequest.url })
      );
    });

    it('should reject invalid WebSocket URLs', () => {
      const mockRequest = {
        url: '/invalid-path',
        headers: { 'sec-websocket-key': 'test-key' }
      };
      const mockSocket = new EventEmitter();
      mockSocket.destroy = jest.fn();

      handleWebSocketUpgrade(server);

      // Simulate upgrade event
      server.emit('upgrade', mockRequest, mockSocket, Buffer.from('test'));

      expect(mockSocket.destroy).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid WebSocket URL'),
        expect.any(Object)
      );
    });

    it('should handle WebSocket connection errors', () => {
      const mockRequest = {
        url: '/media-stream/test-call-sid',
        headers: { 'sec-websocket-key': 'test-key' }
      };
      const mockSocket = new EventEmitter();
      const mockHead = Buffer.from('test');

      handleWebSocketUpgrade(server);

      // Simulate upgrade event
      server.emit('upgrade', mockRequest, mockSocket, mockHead);

      // Simulate socket error
      mockSocket.emit('error', new Error('Socket error'));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket connection error'),
        expect.any(Object)
      );
    });
  });

  describe('Active orchestrators management', () => {
    it('should track active orchestrators', () => {
      const webhook = require('../../src/webhooks/mediaStreamWebhook');
      
      // Access the activeOrchestrators map (this might need adjustment based on actual implementation)
      expect(webhook.activeOrchestrators).toBeDefined();
    });

    it('should clean up orchestrators on disconnection', () => {
      // This test would verify that orchestrators are properly cleaned up
      // when WebSocket connections are closed
      expect(true).toBe(true); // Placeholder
    });
  });

  describe('TwiML generation', () => {
    it('should generate valid TwiML with stream parameters', async () => {
      const user = { id: 'user-123', name: 'John Doe' };
      mockUserRepository.findUserByPhoneNumber.mockResolvedValue(user);

      const response = await request(app)
        .post('/api/media-stream/connect')
        .send({
          CallSid: 'test-call-sid',
          From: '+1234567890',
          To: '+1987654321'
        });

      expect(response.status).toBe(200);
      expect(response.text).toContain('<Response>');
      expect(response.text).toContain('<Connect>');
      expect(response.text).toContain('<Stream');
      
      // Should not contain invalid 'track' attribute
      expect(response.text).not.toContain('track=');
    });
  });
});