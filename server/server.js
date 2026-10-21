// Small read-only bank server for the calendar app. Keys live ONLY in Render env vars.
// Env (Kraken: KRAKEN_API_KEY, KRAKEN_API_SECRET): PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (production|sandbox), APP_PASSCODE,
//      PLAID_ACCESS_TOKEN (set after you link your bank once), ALLOWED_ORIGIN (optional)
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const { PLAID_CLIENT_ID, PLAID_SECRET, APP_PASSCODE, ALLOWED_ORIGIN } = process.env;
const PLAID_ENV = process.env.PLAID_ENV || 'production';
let accessToken = process.env.PLAID_ACCESS_TOKEN || '';

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: { headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID, 'PLAID-SECRET': PLAID_SECRET } }
}));

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',') : true }));

// Passcode gate: nobody can read balances without the app's passcode.
app.use((req, res, next) => {
  if (req.path === '/') return next();
  if (!APP_PASSCODE || req.get('x-app-passcode') !== APP_PASSCODE) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/', (req, res) => res.send('ok'));
app.get('/status', (req, res) => res.json({ linked: !!accessToken, env: PLAID_ENV }));

// 1) App asks for a link token, opens Plaid Link with it.
app.post('/link/token', async (req, res) => {
  try {
    const r = await plaid.linkTokenCreate({
      user: { client_user_id: 'justin' },
      client_name: 'My Calendar',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {})
    });
    res.json({ link_token: r.data.link_token });
  } catch (e) { fail(res, e); }
});

// 2) After you log in to Chase in Plaid Link, the app sends the public token here.
//    The permanent access token is printed in the Render logs ONCE; put it in the PLAID_ACCESS_TOKEN env var.
app.post('/link/exchange', async (req, res) => {
  try {
    const r = await plaid.itemPublicTokenExchange({ public_token: req.body.public_token });
    accessToken = r.data.access_token;
    console.log('PLAID_ACCESS_TOKEN=' + accessToken);
    res.json({ ok: true, note: 'Linked. Save the token from the server logs into PLAID_ACCESS_TOKEN so it survives restarts.' });
  } catch (e) { fail(res, e); }
});

// Live balance of checking/savings accounts.
app.get('/balance', async (req, res) => {
  if (!accessToken) return res.status(409).json({ error: 'not_linked' });
  try {
    const r = await plaid.accountsBalanceGet({ access_token: accessToken });
    const accounts = r.data.accounts
      .filter(a => a.type === 'depository')
      .map(a => ({ id: a.account_id, name: a.name, mask: a.mask, subtype: a.subtype, available: a.balances.available, current: a.balances.current }));
    const total = accounts.reduce((s, a) => s + (a.available ?? a.current ?? 0), 0);
    res.json({ total, accounts, asOf: new Date().toISOString() });
  } catch (e) { fail(res, e); }
});

// Money IN (deposits) between two dates: Plaid shows inflows as negative amounts.
app.get('/deposits', async (req, res) => {
  if (!accessToken) return res.status(409).json({ error: 'not_linked' });
  const { start, end } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return res.status(400).json({ error: 'bad_dates' });
  try {
    let all = [], offset = 0, total = 1;
    while (offset < total) {
      const r = await plaid.transactionsGet({ access_token: accessToken, start_date: start, end_date: end, options: { count: 250, offset } });
      all = all.concat(r.data.transactions); total = r.data.total_transactions; offset = all.length;
      if (!r.data.transactions.length) break;
    }
    const deposits = all.filter(t => t.amount < 0 && !t.pending).map(t => ({ date: t.date, name: t.name, amount: -t.amount }));
    res.json({ total: deposits.reduce((s, d) => s + d.amount, 0), deposits });
  } catch (e) { fail(res, e); }
});

// ---- Kraken (read-only, "Query funds" key). Env: KRAKEN_API_KEY, KRAKEN_API_SECRET ----
const crypto = require('crypto');
let lastNonce = 0;
async function krakenPrivate(path, params = {}) {
  const { KRAKEN_API_KEY, KRAKEN_API_SECRET } = process.env;
  if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) { const e = new Error('kraken_not_configured'); e.code = 'kraken_not_configured'; throw e; }
  lastNonce = Math.max(Date.now() * 1000, lastNonce + 1);
  const body = new URLSearchParams({ nonce: String(lastNonce), ...params }).toString();
  const sha = crypto.createHash('sha256').update(String(lastNonce) + body).digest();
  const sig = crypto.createHmac('sha512', Buffer.from(KRAKEN_API_SECRET, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
  const r = await fetch('https://api.kraken.com' + path, { method: 'POST', headers: { 'API-Key': KRAKEN_API_KEY, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (j.error && j.error.length) { const e = new Error(j.error.join(',')); e.code = j.error[0]; throw e; }
  return j.result;
}
app.get('/kraken/balance', async (req, res) => {
  try {
    const [bal, tb] = await Promise.all([krakenPrivate('/0/private/Balance'), krakenPrivate('/0/private/TradeBalance', { asset: 'ZUSD' })]);
    const holdings = Object.entries(bal).map(([asset, amt]) => ({ asset, amount: Number(amt) })).filter(h => h.amount > 0);
    res.json({ total: Number(tb.eb) || 0, holdings, asOf: new Date().toISOString() });
  } catch (e) {
    console.error('kraken', e.code || e.message);
    res.status(e.code === 'kraken_not_configured' ? 409 : 500).json({ error: e.code || 'kraken_error' });
  }
});

function fail(res, e) {
  const d = e && e.response && e.response.data;
  console.error(d || e);
  res.status(500).json({ error: (d && d.error_code) || 'server_error' });
}

app.listen(process.env.PORT || 3000, () => console.log('bank server up'));
