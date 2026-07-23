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

// Global states to capture payment success notifications from webhooks
let paymentReceived = false;
let lastPaymentTime = 0;

// Webhook Receiver Endpoint (Target: https://www.coreblock.in/api/payment/webhook)
app.post('/api/payment/webhook', (req, res) => {
  const event = req.body.event;
  console.log(`[WEBHOOK] Received event from Razorpay: ${event}`);
  
  if (event === 'payment.captured' || event === 'payment.authorized') {
    paymentReceived = true;
    lastPaymentTime = Date.now();
    console.log(`[WEBHOOK] SUCCESS: Payment successfully recorded at ${new Date(lastPaymentTime).toISOString()}`);
  }
  
  res.json({ status: 'ok' });
});

// Create static Payment Link session
app.post('/api/payment/create', async (req, res) => {
  console.log('[DEBUG] Received POST /api/payment/create');
  
  const amount = req.body.amount || process.env.QR_AMOUNT || 50;

  // Immediately return the static link to bypass dynamic API latency and ensure 100% compile/link stability
  res.json({
    qr_id: 'static_link',
    upi_intent: 'https://rzp.io/rzp/u0mFBFz', // User's static payment page URL
    amount: amount
  });
});

// Fetch payment status directly from local webhook state (45-second sliding window)
app.get('/api/payment/status', async (req, res) => {
  const now = Date.now();
  // Return 'paid' if a success webhook has been received in the last 45 seconds
  const isPaid = paymentReceived && (now - lastPaymentTime < 45000);

  console.log(`[DEBUG] Received GET /api/payment/status. isPaid: ${isPaid} (Last payment was ${now - lastPaymentTime}ms ago)`);

  res.json({
    qr_id: 'static_link',
    status: isPaid ? 'paid' : 'pending'
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
