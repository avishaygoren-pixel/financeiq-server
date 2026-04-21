const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

// ── Plaid setup ──────────────────────────────────────────────────────────────
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(configuration);

// ── In-memory token store (fine for single-user app) ────────────────────────
// Maps itemId → access_token, stored only on the server
const tokenStore = {};

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: PLAID_ENV,
    connectedAccounts: Object.keys(tokenStore).length,
  });
});

// ── Step 1: Create link token (opens Plaid modal in browser) ─────────────────
app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'financeiq-owner' },
      client_name: 'FinanceIQ',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
redirect_uri: process.env.PLAID_REDIRECT_URI,
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error('create_link_token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

// ── Step 2: Exchange public token → store access token server-side ────────────
// access_token is NEVER sent to the browser
app.post('/api/exchange_token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Store server-side only
    tokenStore[itemId] = accessToken;
    console.log(`Connected item: ${itemId} (total: ${Object.keys(tokenStore).length})`);

    // Return only the itemId — never the access token
    res.json({ success: true, itemId });
  } catch (e) {
    console.error('exchange_token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 3: Get accounts for all connected banks ──────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const allAccounts = [];

    for (const [itemId, accessToken] of Object.entries(tokenStore)) {
      const response = await plaidClient.accountsGet({ access_token: accessToken });
      allAccounts.push(...response.data.accounts);
    }

    res.json({ accounts: allAccounts });
  } catch (e) {
    console.error('accounts error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Step 4: Get transactions for all connected banks ──────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    const allTransactions = [];
    const now = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);

    for (const [itemId, accessToken] of Object.entries(tokenStore)) {
      const response = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: start.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
        options: { count: 500, offset: 0 },
      });
      allTransactions.push(...response.data.transactions);
    }

    // Sort newest first
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTransactions });
  } catch (e) {
    console.error('transactions error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FinanceIQ server running on port ${PORT}`);
  console.log(`Plaid environment: ${PLAID_ENV}`);
});
