const express = require('express');
const cors = require('cors');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for testing
app.use(cors());

// Configure Express to parse JSON
app.use(express.json());

// Global handlers to capture any async or library crashes and log them
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception thrown:', err);
});

// Helper to shorten the UPI URL from Razorpay to fit in small DWIN basic graphic buffers
function shortenUpiUrl(urlStr) {
  try {
    const queryString = urlStr.split('?')[1];
    if (!queryString) return urlStr;
    
    const params = new URLSearchParams(queryString);
    const pa = params.get('pa');
    const pn = params.get('pn');
    const am = params.get('am');
    const tr = params.get('tr');
    
    if (pa && pn && am && tr) {
      const shortened = `upi://pay?pa=${pa}&pn=${pn}&am=${am}&tr=${tr}`;
      console.log(`[DEBUG] Shortened UPI URL: ${shortened} (Length: ${shortened.length} chars)`);
      return shortened;
    }
  } catch (e) {
    console.error('[DEBUG] Failed to parse UPI URL for shortening:', e);
  }
  return urlStr;
}

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn'
});

console.log(`[DEBUG] Razorpay Key ID: ${process.env.RAZORPAY_KEY_ID ? 'Loaded from .env' : 'Using default test ID'}`);

// Root status endpoint
app.get('/', (req, res) => {
  res.json({ status: 'active', service: 'FreshPod Direct Payment API' });
});

// Create dynamic QR code and return decoded UPI string
app.post('/api/payment/create', async (req, res) => {
  console.log('[DEBUG] Received POST /api/payment/create');
  console.log('[DEBUG] Request body:', JSON.stringify(req.body));

  try {
    const { machine_id } = req.body;
    // Prioritize request body, fallback to Vercel env variable, default to 69
    const amount = req.body.amount || process.env.QR_AMOUNT || 69;

    if (!machine_id) {
      console.warn('[DEBUG] Validation failed: machine_id is missing');
      return res.status(400).json({ error: 'Missing machine_id' });
    }

    console.log(`[DEBUG] Creating Payment Link: Machine = ${machine_id}, Resolved Amount = INR ${amount}`);

    // 1. Call Razorpay Payment Links API to create a single-use payment link
    const linkOptions = {
      amount: Math.round(parseFloat(amount) * 100), // convert to paise
      currency: 'INR',
      accept_partial: false,
      description: `FreshPod Payment - Machine ${machine_id}`,
      customer: {
        name: 'FreshPod User',
        email: 'customer@freshpod.in',
        contact: '+919876543210'
      },
      notify: {
        sms: false,
        email: false
      },
      reminder_enable: false,
      notes: {
        machine_id: machine_id
      }
    };

    console.log('[DEBUG] Calling Razorpay API with options:', JSON.stringify(linkOptions));
    let paymentLink;
    try {
      paymentLink = await razorpay.paymentLink.create(linkOptions);
      console.log(`[DEBUG] Razorpay Payment Link created: ${paymentLink.id}`);
      console.log(`[DEBUG] Short URL: ${paymentLink.short_url}`);
    } catch (rzpError) {
      console.error('[DEBUG] Razorpay API call failed:', rzpError);
      return res.status(502).json({ 
        error: 'Bad Gateway', 
        message: 'Failed to create Payment Link via Razorpay API', 
        details: rzpError.message || rzpError 
      });
    }

    // 2. Return directly to ESP32 (no image downloading or decoding needed!)
    res.json({
      qr_id: paymentLink.id,
      upi_intent: paymentLink.short_url,
      amount: amount
    });

  } catch (error) {
    console.error('[DEBUG] Unexpected system error inside /api/payment/create:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message || error });
  }
});

// Fetch payment status directly from Razorpay (Polling endpoint)
app.get('/api/payment/status', async (req, res) => {
  const { qr_id } = req.query; // qr_id is the paymentLink.id (e.g. plink_XXXX)
  console.log(`[DEBUG] Received GET /api/payment/status for Payment Link ID: ${qr_id}`);

  if (!qr_id) {
    console.warn('[DEBUG] Missing qr_id parameter');
    return res.status(400).json({ error: 'Missing qr_id parameter' });
  }

  try {
    console.log(`[DEBUG] Querying Razorpay for Payment Link ID: ${qr_id}...`);
    const paymentLink = await razorpay.paymentLink.fetch(qr_id);
    
    const isPaid = paymentLink.status === 'paid';
    console.log(`[DEBUG] Query result - ID: ${qr_id}, Status: ${paymentLink.status}`);

    res.json({
      qr_id: qr_id,
      status: isPaid ? 'paid' : 'pending',
      amount: paymentLink.amount / 100, // Expected amount in INR
      amount_received: isPaid ? paymentLink.amount / 100 : 0
    });
  } catch (error) {
    console.error(`[DEBUG] Error checking Payment Link status from Razorpay:`, error.message || error);
    res.status(500).json({ error: 'Failed to fetch status from Razorpay', details: error.message || error });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
