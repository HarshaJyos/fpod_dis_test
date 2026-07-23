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

// Render a premium administrative dashboard displaying transaction logs
app.get('/dashboard', async (req, res) => {
  try {
    console.log('[DEBUG] Querying Razorpay for payment list...');
    const response = await razorpay.payments.all({ count: 100 });
    const payments = response.items || [];

    const rows = payments.map(p => {
      const date = new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const amount = (p.amount / 100).toFixed(2);
      const statusClass = p.status === 'captured' ? 'captured' : (p.status === 'failed' ? 'failed' : (p.status === 'authorized' ? 'authorized' : 'other'));
      const contact = p.contact || p.email || 'N/A';
      return `
        <tr>
          <td style="color: #94a3b8;">${date}</td>
          <td style="font-family: monospace; color: #00d2ff;">${p.id}</td>
          <td class="amount">₹${amount}</td>
          <td style="text-transform: capitalize;">${p.method}</td>
          <td><span class="badge badge-${statusClass}">${p.status}</span></td>
          <td>${contact}</td>
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
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0d0f14;
            --card-bg: rgba(22, 28, 38, 0.7);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-color: #e2e8f0;
            --success-color: #10b981;
            --failed-color: #ef4444;
        }
        body {
            font-family: 'Outfit', sans-serif;
            background: radial-gradient(circle at top left, #1a2035 0%, var(--bg-color) 70%);
            color: var(--text-color);
            margin: 0;
            padding: 40px 20px;
            min-height: 100vh;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
        }
        h1 {
            font-size: 2.2rem;
            font-weight: 700;
            margin: 0;
            background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #64748b;
            margin-top: 5px;
        }
        .btn {
            background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 1rem;
            font-weight: 600;
            border-radius: 12px;
            cursor: pointer;
            text-decoration: none;
            transition: all 0.3s ease;
            box-shadow: 0 4px 20px rgba(79, 70, 229, 0.3);
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 25px rgba(79, 70, 229, 0.5);
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            backdrop-filter: blur(16px);
            border-radius: 20px;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            overflow-x: auto;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }
        th {
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #64748b;
            padding: 15px 20px;
            border-bottom: 1px solid var(--border-color);
        }
        td {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border-color);
            font-size: 0.95rem;
        }
        tr:last-child td {
            border-bottom: none;
        }
        tr:hover td {
            background: rgba(255, 255, 255, 0.01);
        }
        .badge {
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 0.8rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-captured {
            background: rgba(16, 185, 129, 0.12);
            color: var(--success-color);
        }
        .badge-failed {
            background: rgba(239, 68, 68, 0.12);
            color: var(--failed-color);
        }
        .badge-authorized {
            background: rgba(245, 158, 11, 0.12);
            color: #f59e0b;
        }
        .badge-other {
            background: rgba(100, 116, 139, 0.12);
            color: #94a3b8;
        }
        .amount {
            font-family: monospace;
            font-size: 1.05rem;
            font-weight: 600;
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
            <a href="/api/payments/export" class="btn">Export to CSV (Excel)</a>
        </header>
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
