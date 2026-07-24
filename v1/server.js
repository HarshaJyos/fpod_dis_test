const express = require('express');
const cors = require('cors');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and serve static files
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Global handlers to capture any async or library crashes and log them
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception thrown:', err);
});

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn'
});

console.log(`[DEBUG] Razorpay Key ID: ${process.env.RAZORPAY_KEY_ID ? 'Loaded from .env' : 'Using default test ID'}`);

// Firebase Configuration & Initialization (Web Client SDK used inside Node.js)
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, onSnapshot } = require('firebase/firestore');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Global states for caching the current payment link and current amount
let currentPaymentLink = null;
let currentAmount = process.env.QR_AMOUNT || 50;

// Synchronize payment price from Firestore in real-time
onSnapshot(doc(db, "config", "kiosk"), (snapshot) => {
  if (snapshot.exists()) {
    const data = snapshot.data();
    if (data && data.amount) {
      currentAmount = data.amount;
      currentPaymentLink = null; // Invalidate cached payment links immediately when price changes
      console.log(`[FIRESTORE] Price sync: active amount updated to INR ${currentAmount}. Cache reset.`);
    }
  }
}, (error) => {
  console.error('[FIRESTORE] Sync listener failed:', error);
});

// Root status endpoint
app.get('/', (req, res) => {
  res.json({ status: 'active', service: 'FreshPod Direct Payment API' });
});

// Static HTML views routes
app.get('/login', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// Serve Firebase configuration dynamically to front-end to keep credentials out of code files
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  });
});

// API endpoint for dashboard to fetch payments list
app.get('/api/payments/all', async (req, res) => {
  try {
    console.log('[DEBUG] Querying Razorpay for payment list...');
    const response = await razorpay.payments.all({ count: 100 });
    res.json(response.items || []);
  } catch (error) {
    console.error('Failed to query payments for dashboard:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// CSV Export Endpoint for Excel download
app.get('/api/payments/export', async (req, res) => {
  try {
    console.log('[DEBUG] Querying Razorpay for exporting payments...');
    const response = await razorpay.payments.all({ count: 100 });
    const payments = response.items || [];
    
    let csv = 'Payment ID,Date,Amount (INR),Method,Status,Customer Email,Customer Contact\n';
    payments.forEach(p => {
      const date = new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const amount = (p.amount / 100).toFixed(2);
      const email = p.email || 'N/A';
      const contact = p.contact || 'N/A';
      csv += `"${p.id}","${date}",${amount},"${p.method}","${p.status}","${email}","${contact}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=freshpod_payments.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).send(`Export failed: ${error.message || error}`);
  }
});

// Webhook Receiver Endpoint (Optional backup)
app.post('/api/payment/webhook', (req, res) => {
  const event = req.body.event;
  console.log(`[WEBHOOK] Received event from Razorpay: ${event}`);
  res.json({ status: 'ok' });
});

// Create/Fetch cached Payment Link
app.post('/api/payment/create', async (req, res) => {
  console.log('[DEBUG] Received POST /api/payment/create');
  
  try {
    const machineId = req.body.machine_id || 'FP_MACHINE_01';

    // Check if the current cached link has already been paid or canceled. If so, invalidate it!
    if (currentPaymentLink) {
      try {
        console.log(`[CACHE] Checking status of cached link: ${currentPaymentLink.id}...`);
        const statusCheck = await razorpay.paymentLink.fetch(currentPaymentLink.id);
        if (statusCheck.status === 'paid' || statusCheck.status === 'cancelled' || statusCheck.status === 'expired') {
          console.log(`[CACHE] Link ${currentPaymentLink.id} is already ${statusCheck.status}. Invalidating cache...`);
          currentPaymentLink = null;
        }
      } catch (err) {
        console.error('[CACHE] Error validating cached link status. Invalidating to be safe:', err.message);
        currentPaymentLink = null;
      }
    }

    // If no active cached link exists, generate a fresh one
    if (!currentPaymentLink) {
      console.log(`[CACHE] Generating fresh Payment Link for amount: INR ${currentAmount}`);
      const paymentLink = await razorpay.paymentLink.create({
        upi_link: true, // Optimizes the checkout specifically for UPI deep linking
        amount: Math.round(parseFloat(currentAmount) * 100), // convert to paise
        currency: 'INR',
        accept_partial: false,
        description: `FreshPod Payment - Machine ${machineId}`,
        customer: {
          name: 'FreshPod User',
          email: 'support@coreblock.in',
          contact: '+919032185199'
        },
        notify: {
          sms: false,
          email: false
        },
        reminder_enable: false,
        notes: {
          machine_id: machineId
        }
      });
      currentPaymentLink = paymentLink;
    }

    res.json({
      qr_id: currentPaymentLink.id,
      upi_intent: currentPaymentLink.short_url,
      amount: currentAmount
    });
  } catch (error) {
    console.error('[DEBUG] Failed to resolve Payment Link:', error);
    res.status(502).json({
      error: 'Bad Gateway',
      message: 'Failed to create Payment Link via Razorpay API',
      details: error.message || error
    });
  }
});

// Fetch payment status directly from Razorpay (stateless polling)
app.get('/api/payment/status', async (req, res) => {
  const { qr_id } = req.query;
  console.log(`[DEBUG] Received GET /api/payment/status for Payment Link ID: ${qr_id}`);

  if (!qr_id || qr_id === 'static_link') {
    return res.json({ qr_id: qr_id, status: 'pending' });
  }

  try {
    const paymentLink = await razorpay.paymentLink.fetch(qr_id);
    const isPaid = paymentLink.status === 'paid';
    
    console.log(`[DEBUG] Direct Razorpay check - ID: ${qr_id}, Status: ${paymentLink.status}`);

    if (isPaid) {
      // Invalidate the cache immediately upon successful payment detection
      if (currentPaymentLink && currentPaymentLink.id === qr_id) {
        console.log(`[STATUS] Link ${qr_id} has been paid. Invalidating cache immediately.`);
        currentPaymentLink = null;
      }
    }

    res.json({
      qr_id: qr_id,
      status: isPaid ? 'paid' : 'pending'
    });
  } catch (error) {
    console.error(`[DEBUG] Error checking status for ID ${qr_id}:`, error.message || error);
    res.status(500).json({ error: 'Failed to fetch status from Razorpay', details: error.message || error });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
