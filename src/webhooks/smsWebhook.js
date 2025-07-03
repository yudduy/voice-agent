const express = require('express');
const Twilio = require('twilio');
const smsHandler = require('../services/smsHandler');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Express middleware to validate Twilio requests.
 *
 * It's crucial to protect your webhooks from fraudulent requests.
 * This middleware checks the X-Twilio-Signature header.
 */
const validateTwilioRequest = Twilio.webhook(process.env.TWILIO_AUTH_TOKEN, {
    url: `${process.env.BASE_URL}/webhooks/sms`,
});

/**
 * POST /webhooks/sms
 *
 * This webhook receives incoming SMS messages from Twilio.
 * It validates the request and passes the payload to the SMS handler service.
 */
router.post('/sms', validateTwilioRequest, async (req, res) => {
    logger.info(`Received incoming SMS from ${req.body.From}`);
    
    try {
        await smsHandler.handleIncomingSms(req.body);
        
        // Twilio requires a 204 No Content response to acknowledge receipt.
        // The actual reply is sent asynchronously by the smsHandler.
        res.status(204).send();
    } catch (error) {
        logger.error('Error in SMS webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router; 