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

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TD1URCZFZQYVar',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'Cnet67kJGckHvtTDfb0BRo9W'
});

console.log(`Razorpay Key ID loaded: ${process.env.RAZORPAY_KEY_ID ? 'Custom' : 'Default (Test)'}`);

// Root status endpoint
app.get('/', (req, res) => {
  res.json({ status: 'active', service: 'FreshPod Direct Payment API' });
});

// Create dynamic QR code and return decoded UPI string
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, machine_id } = req.body;

    if (!amount || !machine_id) {
      return res.status(400).json({ error: 'Missing amount or machine_id' });
    }

    console.log(`Creating QR Code for Machine: ${machine_id}, Amount: INR ${amount}`);

    // 1. Call Razorpay QR Codes API to create a single-use QR code
    const qrOptions = {
      type: 'upi_qr',
      name: `FP_${machine_id}`,
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: Math.round(amount * 100), // convert to paise
      description: `FreshPod Payment - Machine ${machine_id}`,
      notes: {
        machine_id: machine_id
      }
    };

    const qrCode = await razorpay.qrCode.create(qrOptions);
    console.log(`Razorpay QR Code created: ${qrCode.id}, Image URL: ${qrCode.image_url}`);

    // 2. Fetch and Decode QR Code Image to get the UPI string
    console.log('Downloading and decoding QR image...');
    const image = await Jimp.read(qrCode.image_url);
    const decoded = jsQR(
      new Uint8ClampedArray(image.bitmap.data),
      image.bitmap.width,
      image.bitmap.height
    );

    if (!decoded) {
      throw new Error('Jimp/jsQR failed to decode UPI string from Razorpay image');
    }

    const upiIntent = decoded.data;
    console.log(`Decoded UPI String: ${upiIntent}`);

    // 3. Return to ESP32
    res.json({
      qr_id: qrCode.id,
      upi_intent: upiIntent,
      amount: amount
    });

  } catch (error) {
    console.error('Error in /api/payment/create:', error.message || error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Fetch payment status directly from Razorpay (Polling endpoint)
app.get('/api/payment/status', async (req, res) => {
  const { qr_id } = req.query;

  if (!qr_id) {
    return res.status(400).json({ error: 'Missing qr_id parameter' });
  }

  try {
    console.log(`Checking status of QR: ${qr_id} directly from Razorpay...`);
    const qrCode = await razorpay.qrCode.fetch(qr_id);
    
    // Check if any payment was received on this single_use QR code
    const amountReceived = qrCode.payments_amount_received || 0;
    const isPaid = amountReceived > 0;
    
    console.log(`QR Code ID: ${qr_id} status: ${isPaid ? 'PAID' : 'PENDING'} (Received: ${amountReceived / 100} INR)`);

    res.json({
      qr_id: qr_id,
      status: isPaid ? 'paid' : 'pending',
      amount: qrCode.payment_amount / 100, // Expected amount in INR
      amount_received: amountReceived / 100 // Received amount in INR
    });
  } catch (error) {
    console.error(`Error fetching QR code status from Razorpay:`, error.message || error);
    res.status(500).json({ error: 'Failed to fetch status from Razorpay', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
