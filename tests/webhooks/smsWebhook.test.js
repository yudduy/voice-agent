/* eslint-env jest */

const request = require('supertest');
const express = require('express');
const smsWebhookRouter = require('../../src/webhooks/smsWebhook');
const smsHandler = require('../../src/services/smsHandler');
const Twilio = require('twilio');

// Mock dependencies
jest.mock('../../src/services/smsHandler', () => ({
  handleIncomingSms: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

// Mock the Twilio validation middleware
jest.mock('twilio', () => ({
  webhook: jest.fn(() => (req, res, next) => next()), // Middleware mock that just passes through
}));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/webhooks', smsWebhookRouter);

describe('SMS Webhook', () => {
  const twilioPayload = {
    From: '+15551234567',
    To: '+15557654321',
    Body: 'Hello',
    MessageSid: 'SM1234567890',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.BASE_URL = 'http://test.com';
  });

  it('should call the smsHandler on a valid POST request to /sms', async () => {
    smsHandler.handleIncomingSms.mockResolvedValue();

    const response = await request(app)
      .post('/webhooks/sms')
      .send(twilioPayload);

    expect(response.status).toBe(204);
    expect(smsHandler.handleIncomingSms).toHaveBeenCalledTimes(1);
    expect(smsHandler.handleIncomingSms).toHaveBeenCalledWith(twilioPayload);
  });

  it('should return 500 if the smsHandler throws an error', async () => {
    const handlerError = new Error('Handler failed');
    smsHandler.handleIncomingSms.mockRejectedValue(handlerError);

    const response = await request(app)
      .post('/webhooks/sms')
      .send(twilioPayload);

    expect(response.status).toBe(500);
    expect(response.text).toBe('Internal Server Error');
    expect(smsHandler.handleIncomingSms).toHaveBeenCalledTimes(1);
  });

  it('should invoke Twilio webhook validation', () => {
    // This test re-imports the module to check the middleware configuration
    jest.isolateModules(() => {
        require('../../src/webhooks/smsWebhook');
        expect(Twilio.webhook).toHaveBeenCalledWith('test-token', {
            url: 'http://test.com/webhooks/sms',
        });
    });
  });
}); 