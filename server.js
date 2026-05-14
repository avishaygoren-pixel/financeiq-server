const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin setup ──────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ── Plaid setup ───────────────────────────────────────────────────────────────
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
const tokenStore = {};

async function loadTokensFromFirestore() {
  try {
    const snap = await db.collection('plaid_tokens').get();
    snap.forEach(doc => {
      const { itemId, accessToken } = doc.data();
      if (itemId && accessToken) tokenStore[itemId] = accessToken;
    });
    console.log(`Loaded ${Object.keys(tokenStore).length} tokens from Firestore`);
  } catch (e) {
    console.error('Failed to load tokens:', e.message);
  }
}

async function saveToken(itemId, accessToken) {
  try {
    await db.collection('plaid_tokens').doc(itemId).set({ itemId, accessToken, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Failed to save token:', e.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: PLAID_ENV, connectedItems: Object.keys(tokenStore).length });
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTransactionsWithRetry(accessToken, startDate, endDate, retries = 6, delayMs = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset: 0 },
      });
      return response.data.transactions;
    } catch (e) {
      const code = e.response?.data?.error_code;
      if (code === 'PRODUCT_NOT_READY' && i < retries - 1) {
        console.log(`PRODUCT_NOT_READY — retrying in ${delayMs/1000}s (attempt ${i+1}/${retries})`);
        await sleep(delayMs);
      } else {
        throw e;
      }
    }
  }
}

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

app.post('/api/exchange_token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    tokenStore[itemId] = accessToken;
    await saveToken(itemId, accessToken);
    console.log(`Connected item: ${itemId} (total: ${Object.keys(tokenStore).length})`);

    const accResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const accounts = accResponse.data.accounts;

    const now = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const startDate = start.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    let transactions = [];
    try {
      transactions = await fetchTransactionsWithRetry(accessToken, startDate, endDate);
      console.log(`Fetched ${transactions.length} transactions for item ${itemId}`);
    } catch (e) {
      console.log(`Transactions not ready for ${itemId} — client should retry`);
    }

    res.json({ success: true, itemId, accounts, transactions });
  } catch (e) {
    console.error('exchange_token error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const allAccounts = [];
    for (const [itemId, accessToken] of Object.entries(tokenStore)) {
      try {
        const response = await plaidClient.accountsGet({ access_token: accessToken });
        allAccounts.push(...response.data.accounts);
      } catch (e) {
        console.error(`accounts error for ${itemId}:`, e.response?.data || e.message);
      }
    }
    res.json({ accounts: allAccounts });
  } catch (e) {
    console.error('accounts error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const allTransactions = [];
    const now = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 90);
    const startDate = start.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    for (const [itemId, accessToken] of Object.entries(tokenStore)) {
      try {
        const txs = await fetchTransactionsWithRetry(accessToken, startDate, endDate);
        allTransactions.push(...txs);
      } catch (e) {
        console.error(`transactions error for ${itemId}:`, e.response?.data || e.message);
      }
    }

    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTransactions });
  } catch (e) {
    console.error('transactions error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
loadTokensFromFirestore().then(() => {
  app.listen(PORT, () => {
    console.log(`FinanceIQ server running on port ${PORT}`);
    console.log(`Plaid environment: ${PLAID_ENV}`);
  });
});
