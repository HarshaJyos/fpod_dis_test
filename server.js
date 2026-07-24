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

// Configure Express to parse JSON and Form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Global states for caching the current payment link and current amount
let currentPaymentLink = null;
let currentAmount = process.env.QR_AMOUNT || 50;

// Webhook Receiver Endpoint (Optional backup)
app.post('/api/payment/webhook', (req, res) => {
  const event = req.body.event;
  console.log(`[WEBHOOK] Received event from Razorpay: ${event}`);
  res.json({ status: 'ok' });
});

// Update current payment amount from dashboard config
app.post('/api/config/amount', (req, res) => {
  const newAmount = parseInt(req.body.amount);
  if (newAmount > 0) {
    currentAmount = newAmount;
    currentPaymentLink = null; // Invalidate current cached link to generate a new one with the updated amount
    console.log(`[CONFIG] Payment amount updated to INR ${currentAmount}. Invalidating cached payment link...`);
    res.redirect('/dashboard');
  } else {
    res.status(400).send('Invalid amount value');
  }
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

// Render a premium administrative dashboard displaying transaction logs
app.get('/dashboard', async (req, res) => {
  try {
    console.log('[DEBUG] Querying Razorpay for payment list...');
    const response = await razorpay.payments.all({ count: 100 });
    const payments = response.items || [];
    const isUpdated = req.query.updated === 'true';

    const rows = payments.map(p => {
      const date = new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const amount = (p.amount / 100).toFixed(2);
      const statusClass = p.status === 'captured' ? 'captured' : (p.status === 'failed' ? 'failed' : (p.status === 'authorized' ? 'authorized' : 'other'));
      const contact = p.contact || p.email || 'N/A';
      return `
        <tr>
          <td>${date}</td>
          <td class="tx-id">${p.id}</td>
          <td class="amount">₹${amount}</td>
          <td style="text-transform: capitalize;">${p.method}</td>
          <td><span class="badge badge-${statusClass}">${p.status}</span></td>
          <td class="contact-info">${contact}</td>
        </tr>
      `;
    }).join('\n');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FreshPod Transaction Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #f8fafc;
            --card-bg: #ffffff;
            --border-color: #e2e8f0;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --accent-color: #2563eb;
            --accent-hover: #1d4ed8;
            --success-bg: #dcfce7;
            --success-text: #15803d;
            --failed-bg: #fee2e2;
            --failed-text: #b91c1c;
            --warning-bg: #fef3c7;
            --warning-text: #b45309;
        }
        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-primary);
            margin: 0;
            padding: 40px 20px;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
        }
        .container {
            max-width: 1100px;
            margin: 0 auto;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }
        h1 {
            font-size: 1.8rem;
            font-weight: 700;
            margin: 0;
            color: var(--text-primary);
            letter-spacing: -0.5px;
        }
        .subtitle {
            color: var(--text-secondary);
            font-size: 0.95rem;
            margin-top: 4px;
            font-family: 'Inter', sans-serif;
        }
        .btn {
            background-color: var(--accent-color);
            color: #ffffff;
            border: none;
            padding: 10px 20px;
            font-size: 0.9rem;
            font-weight: 600;
            border-radius: 8px;
            cursor: pointer;
            text-decoration: none;
            transition: background-color 0.2s ease, transform 0.1s ease;
            display: inline-flex;
            align-items: center;
            box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        }
        .btn:hover {
            background-color: var(--accent-hover);
        }
        .btn-secondary {
            background-color: #ffffff;
            color: var(--text-secondary);
            border: 1px solid #cbd5e1;
            box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        }
        .btn-secondary:hover {
            background-color: #f1f5f9;
            color: var(--text-primary);
        }
        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);
            overflow-x: auto;
        }
        .settings-card {
            margin-bottom: 24px;
        }
        .alert {
            background-color: var(--success-bg);
            color: var(--success-text);
            padding: 12px 18px;
            border-radius: 8px;
            font-size: 0.9rem;
            font-weight: 500;
            margin-bottom: 24px;
            border: 1px solid rgba(21, 128, 61, 0.15);
            font-family: 'Inter', sans-serif;
        }
        .input-group {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .input-group label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            font-weight: 600;
        }
        .input-field {
            background-color: #ffffff;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            padding: 8px 12px;
            color: var(--text-primary);
            font-size: 0.95rem;
            width: 100px;
            font-family: 'Inter', sans-serif;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
            transition: border-color 0.15s ease;
        }
        .input-field:focus {
            outline: none;
            border-color: var(--accent-color);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-family: 'Inter', sans-serif;
        }
        th {
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
            padding: 14px 18px;
            border-bottom: 1px solid var(--border-color);
            background-color: #f8fafc;
            font-weight: 600;
        }
        td {
            padding: 14px 18px;
            border-bottom: 1px solid var(--border-color);
            font-size: 0.9rem;
            color: var(--text-primary);
        }
        tr:last-child td {
            border-bottom: none;
        }
        tr:hover td {
            background-color: #f8fafc;
        }
        .tx-id {
            font-family: monospace;
            color: var(--text-secondary);
            font-size: 0.85rem;
        }
        .badge {
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-captured {
            background-color: var(--success-bg);
            color: var(--success-text);
        }
        .badge-failed {
            background-color: var(--failed-bg);
            color: var(--failed-text);
        }
        .badge-authorized {
            background-color: var(--warning-bg);
            color: var(--warning-text);
        }
        .badge-other {
            background-color: #f1f5f9;
            color: var(--text-secondary);
        }
        .amount {
            font-family: 'Outfit', sans-serif;
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--text-primary);
        }
        .contact-info {
            color: var(--text-secondary);
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <h1>FreshPod Transaction Dashboard</h1>
                <div class="subtitle">Live payment records retrieved from Razorpay</div>
            </div>
            <a href="/api/payments/export" class="btn btn-secondary">Export to CSV (Excel)</a>
        </header>

        <!-- Dynamic Status Alert -->
        ${isUpdated ? `<div class="alert">Kiosk payment settings updated successfully. Cached session has been cleared.</div>` : ''}

        <!-- Kiosk Settings -->
        <div class="card settings-card">
            <form action="/api/config/amount" method="POST" class="input-group" onsubmit="handleSubmit(event)">
                <label for="amount">Payment Price (INR):</label>
                <input type="number" id="amount" name="amount" value="${currentAmount}" min="1" step="1" required class="input-field">
                <button type="submit" class="btn">Update Price</button>
            </form>
        </div>

        <!-- Transactions Table -->
        <div class="card">
            <table>
                <thead>
                    <tr>
                        <th>Date & Time</th>
                        <th>Payment ID</th>
                        <th>Amount</th>
                        <th>Method</th>
                        <th>Status</th>
                        <th>Contact</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    </div>
    
    <script>
        function handleSubmit(event) {
            const form = event.target;
            const submitBtn = form.querySelector('button[type="submit"]');
            const inputField = form.querySelector('#amount');
            
            // Disable button and change state visual indicator
            submitBtn.disabled = true;
            submitBtn.innerText = 'Updating...';
            submitBtn.style.opacity = '0.7';
            submitBtn.style.cursor = 'not-allowed';
            
            // Prevent changing amount mid-flight but keep value active for POST body inclusion
            inputField.readOnly = true;
            inputField.style.opacity = '0.7';
        }
    </script>
</body>
</html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(`<h1>Error</h1><p>Failed to query Razorpay API: ${error.message || error}</p>`);
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
