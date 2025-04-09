# Foundess Caller

Voice AI calling agent for Foundess that autonomously calls potential clients and investors, engages in natural conversation, and captures conversation transcripts.

## Features

- Connects to MongoDB to fetch contact information
- Makes automated phone calls using Twilio
- Engages in natural conversation using OpenAI's GPT models
- Records and transcribes calls for follow-up
- Schedules calls during business hours
- Handles call status and recording management

## Prerequisites

- Node.js 18.x or higher
- MongoDB Atlas account (or another MongoDB provider)
- Twilio account with a phone number
- OpenAI API key
- Public URL for webhooks (e.g., ngrok for development)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/foundess-caller.git
cd foundess-caller
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit the `.env` file with your credentials:

```bash
# MongoDB
MONGODB_URI=mongodb+srv://your-mongodb-connection-string

# Twilio
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o

# Hyperbolic AI (Optional - for enhanced TTS)
# Used if enabling Hyperbolic Text-to-Speech feature
HYPERBOLIC_API_KEY=your_hyperbolic_api_key

# Speech Service Preferences
# Ensure Twilio call recording is enabled if using Whisper
ENABLE_RECORDING=true 
# Choose preferred STT service: 'whisper' or 'twilio'
SPEECH_RECOGNITION_PREFERENCE=whisper

# Groq API for Speech-to-Text (Optional, requires SPEECH_RECOGNITION_PREFERENCE='groq')
GROQ_API_KEY=your_groq_api_key
GROQ_WHISPER_MODEL=whisper-large-v3 # Or whisper-large-v3-turbo
ENABLE_GROQ_TRANSCRIPTION=true

# Server config
PORT=3000
WEBHOOK_BASE_URL=https://your-webhook-domain.com
```

### 4. Set up public URL for webhooks

For development, you can use ngrok:

```bash
ngrok http 3000
```

Then update your `.env` file with the ngrok URL:

```
WEBHOOK_BASE_URL=https://your-ngrok-url.ngrok.io
```

### 5. Start the server

For development:

```bash
npm run dev
```

For production:

```bash
npm start
```

## Project Structure

```
foundess-caller/
├── src/
│   ├── app.js                     # Main application entry point
│   ├── config/                    # Configuration settings
│   │   ├── database.js            # MongoDB connection config
│   │   ├── telephony.js           # Twilio config
│   │   └── ai.js                  # AI model configs
│   ├── services/
│   │   ├── database.js            # MongoDB connection service
│   │   ├── caller.js              # Call initiation service
│   │   ├── conversation.js        # AI conversation flow manager
│   │   ├── speechToText.js        # Speech recognition service
│   │   ├── textToSpeech.js        # Voice synthesis service
│   │   └── transcript.js          # Call recording/transcription
│   ├── models/
│   │   ├── contact.js             # Contact data model
│   │   └── call.js                # Call data model for tracking calls
│   ├── utils/
│   │   ├── logger.js              # Logging utilities
│   │   └── prompt.js              # Conversation prompts for AI
│   └── webhooks/
│       └── twilioWebhooks.js      # Webhook handlers for Twilio
├── .env                           # Environment variables
├── package.json                   # Project dependencies
└── README.md                      # Project documentation
```

## Testing

To test the system manually, you can use the test endpoint:

```
POST /api/calls/test
Content-Type: application/json

{
  "phone": "+1234567890"
}
```

This will initiate a test call to the specified number.

## Security Considerations

- For production, uncomment and configure the Twilio request validation middleware
- Set up proper authentication for any admin interfaces
- Keep your API keys and tokens secure
- Implement rate limiting for webhook endpoints

## License

This project is proprietary and confidential.

## Troubleshooting

Here are some common issues and how to resolve them:

- **MongoDB Connection Issues:**
  - Ensure your `MONGODB_URI` in `.env` is correct and that your IP address is whitelisted in MongoDB Atlas (if applicable).
  - Check the server logs (`logs/app.log`) for specific connection error messages.

- **ObjectId Casting Errors (e.g., in /test endpoint):**
  - When using endpoints that accept a `contactId` (like `/api/calls/test`), ensure the provided ID is a valid 24-character hexadecimal MongoDB ObjectId.
  - The system is designed to handle temporary test contacts (created using only a phone number) by skipping database operations that would cause errors.

- **Twilio Call Failures (e.g., call hangs up after start):**
  - **Webhook URL:** Verify that the `WEBHOOK_BASE_URL` in your `.env` file is correct and publicly accessible. Use `https://`.
  - **ngrok:** If using ngrok, ensure it's running and the URL in `.env` matches the current ngrok session URL.
  - **Twilio Configuration:** Double-check that the webhook URLs configured in your Twilio Phone Number settings (for Voice & Fax) point to the correct endpoints on your server (e.g., `https://your-webhook-domain.com/api/calls/connect`).
  - **Server Logs:** Check the server logs (`logs/app.log`) for errors reported by the Twilio webhook handlers (`/api/calls/connect`, `/api/calls/respond`, `/api/calls/status`). Enhanced logging provides error messages, types, and stack traces.
  - **Twilio Debugger:** Use the Twilio Console Debugger (Monitor -> Logs -> Errors) to see if Twilio reported any errors fetching or executing your webhooks.

- **AI Response Issues (e.g., empty or strange responses):**
  - **OpenAI API Key:** Ensure your `OPENAI_API_KEY` in `.env` is valid and has sufficient credits/quota.
  - **Model:** Check that the `OPENAI_MODEL` specified in `.env` (and used in `src/config/ai.js`) is available to your OpenAI account.
  - **Server Logs:** Look for errors related to the `conversationService` or OpenAI API calls in `logs/app.log`.

- **Environment Variables:**
  - Make sure you have copied `.env.example` to `.env` and filled in *all* required values.
  - Restart the server after making any changes to the `.env` file.
