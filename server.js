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
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TD1URCZFZQYVar',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'Cnet67kJGckHvtTDfb0BRo9W'
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
    const { amount, machine_id } = req.body;

    if (!amount || !machine_id) {
      console.warn('[DEBUG] Validation failed: amount or machine_id is missing');
      return res.status(400).json({ error: 'Missing amount or machine_id' });
    }

    console.log(`[DEBUG] Creating QR Code: Machine = ${machine_id}, Amount = INR ${amount}`);

    // 1. Call Razorpay QR Codes API to create a single-use QR code
    const qrOptions = {
      type: 'upi_qr',
      name: `FP_${machine_id}`,
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: Math.round(parseFloat(amount) * 100), // convert to paise
      description: `FreshPod Payment - Machine ${machine_id}`,
      notes: {
        machine_id: machine_id
      }
    };

    console.log('[DEBUG] Calling Razorpay API with options:', JSON.stringify(qrOptions));
    let qrCode;
    try {
      qrCode = await razorpay.qrCode.create(qrOptions);
      console.log(`[DEBUG] Razorpay QR Code created: ${qrCode.id}`);
      console.log(`[DEBUG] Image URL from Razorpay: ${qrCode.image_url}`);
    } catch (rzpError) {
      console.error('[DEBUG] Razorpay API call failed:', rzpError);
      return res.status(502).json({ 
        error: 'Bad Gateway', 
        message: 'Failed to create QR code via Razorpay API', 
        details: rzpError.message || rzpError 
      });
    }

    // 2. Fetch the image buffer using fetch() with robust error handling
    console.log('[DEBUG] Fetching QR image buffer...');
    let imageBuffer;
    try {
      const imgResponse = await fetch(qrCode.image_url);
      if (!imgResponse.ok) {
        throw new Error(`HTTP error! Status: ${imgResponse.status} ${imgResponse.statusText}`);
      }
      const arrayBuffer = await imgResponse.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
      console.log(`[DEBUG] Image fetched successfully. Size: ${imageBuffer.length} bytes`);
    } catch (fetchError) {
      console.error('[DEBUG] Failed to download QR image from Razorpay URL:', fetchError.message || fetchError);
      return res.status(502).json({ 
        error: 'Bad Gateway', 
        message: 'Failed to download QR code image from Razorpay server', 
        details: fetchError.message || fetchError 
      });
    }

    // 3. Decode the image buffer using Jimp & jsQR
    console.log('[DEBUG] Processing image with Jimp and jsQR...');
    let decoded;
    try {
      const image = await Jimp.read(imageBuffer);
      console.log(`[DEBUG] Jimp parsed image metadata: Width = ${image.bitmap.width}, Height = ${image.bitmap.height}`);
      
      decoded = jsQR(
        new Uint8ClampedArray(image.bitmap.data),
        image.bitmap.width,
        image.bitmap.height
      );
    } catch (jimpError) {
      console.error('[DEBUG] Jimp/jsQR image processing failed:', jimpError.message || jimpError);
      return res.status(500).json({ 
        error: 'Image Processing Failed', 
        message: 'Failed to parse/decode QR code image locally', 
        details: jimpError.message || jimpError 
      });
    }

    if (!decoded) {
      console.error('[DEBUG] QR decoder (jsQR) did not find any QR code data in the image.');
      return res.status(422).json({ 
        error: 'Unprocessable Entity', 
        message: 'Could not detect or read any QR code inside the generated image.' 
      });
    }

    const originalUpiIntent = decoded.data;
    console.log(`[DEBUG] Decoded Original UPI String successfully: ${originalUpiIntent}`);
    const upiIntent = shortenUpiUrl(originalUpiIntent);

    // 4. Return to ESP32
    res.json({
      qr_id: qrCode.id,
      upi_intent: upiIntent,
      amount: amount
    });

  } catch (error) {
    console.error('[DEBUG] Unexpected system error inside /api/payment/create:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message || error });
  }
});

// Fetch payment status directly from Razorpay (Polling endpoint)
app.get('/api/payment/status', async (req, res) => {
  const { qr_id } = req.query;
  console.log(`[DEBUG] Received GET /api/payment/status for QR ID: ${qr_id}`);

  if (!qr_id) {
    console.warn('[DEBUG] Missing qr_id parameter');
    return res.status(400).json({ error: 'Missing qr_id parameter' });
  }

  try {
    console.log(`[DEBUG] Querying Razorpay for QR ID: ${qr_id}...`);
    const qrCode = await razorpay.qrCode.fetch(qr_id);
    
    const amountReceived = qrCode.payments_amount_received || 0;
    const isPaid = amountReceived > 0;
    
    console.log(`[DEBUG] Query result - QR ID: ${qr_id}, Paid: ${isPaid}, Received: ${amountReceived / 100} INR`);

    res.json({
      qr_id: qr_id,
      status: isPaid ? 'paid' : 'pending',
      amount: qrCode.payment_amount / 100, // Expected amount in INR
      amount_received: amountReceived / 100 // Received amount in INR
    });
  } catch (error) {
    console.error(`[DEBUG] Error checking QR status from Razorpay:`, error.message || error);
    res.status(500).json({ error: 'Failed to fetch status from Razorpay', details: error.message || error });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
