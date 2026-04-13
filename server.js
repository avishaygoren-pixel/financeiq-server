const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_BASE_URL = PLAID_ENV === 'development'
  ? 'https://development.plaid.com'
  : 'https://sandbox.plaid.com';

const configuration = new Configuration({
  basePath: PLAID_BASE_URL,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: PLAID_ENV, url: PLAID_BASE_URL });
});

// Create link token
app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'financeiq-user' },
      client_name: 'FinanceIQ',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json(response.data);
  } catch (e) {
    console.error('create_link_token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// Exchange public token for access token
app.post('/api/exchange_token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    res.json(response.data);
  } catch (e) {
    console.error('exchange_token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get transactions (last 90 days)
app.post('/api/transactions', async (req, res) => {
  try {
    const { access_token } = req.body;
    const now = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const start_date = start.toISOString().split('T')[0];
    const end_date = now.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });
    res.json(response.data);
  } catch (e) {
    console.error('transactions error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get accounts
app.post('/api/accounts', async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.accountsGet({ access_token });
    res.json(response.data);
  } catch (e) {
    console.error('accounts error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FinanceIQ server running on port ${PORT}`);
  console.log(`Plaid environment: ${PLAID_ENV}`);
  console.log(`Plaid URL: ${PLAID_BASE_URL}`);
});
