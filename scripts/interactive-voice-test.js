/**
 * INTERACTIVE VOICE TEST
 * ----------------------
 * This script launches (or re-uses) the webhook-powered conversation flow
 * and places a real outbound call to TEST_PHONE. All dialogue is handled by
 * your existing AI + ElevenLabs setup so it feels exactly like production.
 *
 * Usage:
 *   node scripts/interactive-voice-test.js            # phone from TEST_PHONE env
 *   node scripts/interactive-voice-test.js +15551234567
 *
 * Important env vars:
 *   TWILIO_ACCOUNT_SID   TWILIO_AUTH_TOKEN   TWILIO_PHONE_NUMBER
 *   ELEVENLABS_API_KEY   (for high-quality TTS)
 *   TEST_PHONE           (fallback target number)
 *   WEBHOOK_BASE_URL     (public https URL; if missing ngrok is used)
 *   NGROK_AUTHTOKEN      (only when using ngrok)
 *   SKIP_LOCAL_SERVER    (set to "true" if backend is already running)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const twilio = require('twilio');
const ngrok = require('ngrok');
const { startServer } = require('../src/app');
const conversationService = require('../src/services/conversation');
const { bootstrapUser } = require('../tests/utils/bootstrapUser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ensureEnv = (key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
};

['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'].forEach(ensureEnv);

const TARGET_PHONE = process.argv[2] || process.env.TEST_PHONE || '+19713364433';
console.log(`🎯 Target phone: ${TARGET_PHONE} (from ${process.argv[2] ? 'command line' : process.env.TEST_PHONE ? 'TEST_PHONE env' : 'default'})`);

if (!TARGET_PHONE) {
  console.error('❌ Set TEST_PHONE in .env or provide phone number as argument');
  process.exit(1);
}

// Check trial account limitations
const checkTrialAccountLimitations = async () => {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    
    if (account.type === 'Trial') {
      console.log('⚠️  Detected Twilio trial account - checking phone verification...');
      const verifiedNumbers = await client.outgoingCallerIds.list();
      const isVerified = verifiedNumbers.some(num => 
        num.phoneNumber === TARGET_PHONE || 
        num.phoneNumber === TARGET_PHONE.replace(/^\+1/, '') ||
        num.phoneNumber === '+1' + TARGET_PHONE.replace(/^\+1/, '')
      );
      
      if (!isVerified) {
        console.error('❌ CRITICAL: Target phone number not verified for trial account');
        console.error(`   Target: ${TARGET_PHONE}`);
        console.error(`   Verified numbers: ${verifiedNumbers.map(n => n.phoneNumber).join(', ')}`);
        console.error('   📱 Verify the phone number in: Twilio Console > Phone Numbers > Verified Caller IDs');
        process.exit(1);
      } else {
        console.log('✅ Target phone number is verified for trial account');
      }
    } else {
      console.log(`✅ Account type: ${account.type} (no verification required)`);
    }
  } catch (error) {
    console.log('⚠️  Could not check account type, proceeding with caution...');
  }
};

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    // 1. Check trial account limitations first
    await checkTrialAccountLimitations();

    // 2. Optionally start local Express server
    if (process.env.SKIP_LOCAL_SERVER !== 'true') {
      console.log(`🚀 Starting local webhook server on port ${PORT}…`);
      await startServer();
      console.log('✅ Express server is running');
    } else {
      console.log('ℹ️  SKIP_LOCAL_SERVER=true → assuming server is already running');
    }

    // 3. Determine public base URL for Twilio callbacks
    let baseUrl = process.env.WEBHOOK_BASE_URL;
    let usingNgrok = false;

    if (!baseUrl) {
      ensureEnv('NGROK_AUTHTOKEN');
      console.log('🌐 Creating ngrok tunnel…');
      
      // Kill any existing ngrok processes to prevent conflicts
      try {
        await ngrok.kill();
        console.log('🧹 Cleaned up existing ngrok processes');
      } catch (killError) {
        // Ignore if no processes to kill
      }
      
      // Create tunnel with proper configuration
      baseUrl = await ngrok.connect({ 
        authtoken: process.env.NGROK_AUTHTOKEN, 
        addr: PORT,
        region: 'us', // Specify region for better performance
        bind_tls: true, // Ensure HTTPS
        onStatusChange: (status) => {
          console.log(`🔄 Ngrok status: ${status}`);
        },
        onLogEvent: (data) => {
          if (data.err) {
            console.error(`❌ Ngrok error: ${data.err}`);
          }
        }
      });
      
      usingNgrok = true;
      console.log(`✅ Ngrok tunnel established: ${baseUrl}`);
      
      // Verify tunnel is working
      console.log('🔍 Verifying tunnel connectivity...');
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          console.log('✅ Tunnel verification successful');
        } else {
          throw new Error(`Tunnel health check failed: ${response.status}`);
        }
      } catch (verifyError) {
        console.error('❌ Tunnel verification failed:', verifyError.message);
        throw new Error(`Webhook tunnel is not accessible: ${verifyError.message}`);
      }
    }

    // Propagate for downstream imports (TTS cache, etc.)
    process.env.WEBHOOK_BASE_URL = baseUrl;
    process.env.BASE_URL = baseUrl;

    // 4. Set up user for conversation
    console.log('👤 Setting up user for conversation…');
    const testUserId = require('crypto').randomUUID();
    const testUser = await bootstrapUser({ 
      id: testUserId,
      phone: TARGET_PHONE,
      name: 'Interactive Test User'
    });
    console.log(`✅ User ready: ${testUser.id}`);

    // 5. Create Twilio client and place the call
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log(`📞 Placing call to ${TARGET_PHONE} from ${process.env.TWILIO_PHONE_NUMBER}`);
    
    const call = await client.calls.create({
      to: TARGET_PHONE,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${baseUrl}/api/calls/connect`,
      statusCallback: `${baseUrl}/api/calls/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: false,
      timeout: 60,
    });

    // 6. IMMEDIATELY initialize conversation mapping to prevent race condition
    // This must happen before any webhook calls
    await conversationService.initializeConversation(call.sid, {
      _id: testUser.id,
      name: testUser.name || 'Interactive Test User',
      phone: TARGET_PHONE,
    });

    // 7. IMMEDIATELY log the call to Supabase to ensure database record exists for status updates
    const historyRepository = require('../src/repositories/historyRepository');
    await historyRepository.logCall({
      user_id: testUser.id,
      phone_number: TARGET_PHONE,
      call_sid: call.sid,
      call_status: 'initiated'
    });

    console.log(`✅ Call initiated!  SID: ${call.sid}`);
    console.log('✅ Conversation mapping initialized');
    console.log('✅ Call record created in Supabase');
    console.log('🎙️  Natural conversation will begin when you answer - the AI will greet you automatically.');
    console.log('💬 Simply talk naturally and the AI will respond using the full voice pipeline.');

    // 8. Poll for status until termination
    const pollInterval = setInterval(async () => {
      try {
        const info = await client.calls(call.sid).fetch();
        console.log(`   Status: ${info.status} | Duration: ${info.duration || 0}s`);
        if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(info.status)) {
          clearInterval(pollInterval);
          console.log(`🏁 Call ended with status: ${info.status}`);
          if (usingNgrok) {
            await ngrok.disconnect();
            await ngrok.kill();
            console.log('🛑 Ngrok tunnel closed');
          }
          process.exit(0);
        }
      } catch (err) {
        console.error('Error fetching call status:', err.message);
      }
    }, 5000);
  } catch (err) {
    console.error('💥 Interactive voice test failed:', err.message);
    process.exit(1);
  }
})(); 