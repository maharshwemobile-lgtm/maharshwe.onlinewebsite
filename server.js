const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;

  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separator = trimmed.indexOf('=');
    if (separator === -1) return;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnvFile();

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_SHEETS_API = 'https://script.google.com/macros/s/AKfycbxbCU1eiCPPMnNx_H7nkMhFpY_Rh_ozP0_xyxn18zCbJ-Lrgbx0iJXhHOrRK6bFvcHIMQ/exec';
const TELEGRAM_SHEET_API_URL = process.env.TELEGRAM_SHEET_API_URL || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SOLUTIONS_FILE = path.join(DATA_DIR, 'solutions.json');
const CURRENCY_FILE = path.join(DATA_DIR, 'currency.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const file of [SOLUTIONS_FILE, CURRENCY_FILE, PRODUCTS_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function requireTelegramKey(req, res, next) {
  const expectedKey = process.env.TELEGRAM_API_KEY;
  if (!expectedKey) return next();
  const providedKey = req.get('x-api-key') || req.query.key || req.body.apiKey || req.body.api_key || '';
  if (providedKey !== expectedKey) return res.status(401).json({ error: true, message: 'Invalid API key' });
  next();
}

function getSheetApiUrl(route, params = {}) {
  if (!TELEGRAM_SHEET_API_URL) return '';
  const url = new URL(TELEGRAM_SHEET_API_URL.replace(/\/+$/, ''));
  url.searchParams.set('route', route.startsWith('/') ? route : '/' + route);
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') url.searchParams.set(key, params[key]);
  });
  return url.toString();
}

async function fetchSheetApi(route, params = {}) {
  const url = getSheetApiUrl(route, params);
  if (!url) return null;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error('Sheet API HTTP ' + response.status);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    const data = await response.json();
    return data && data.ok && Array.isArray(data.data) ? data.data : data;
  } catch (error) {
    console.warn('Sheet API fetch failed for ' + route + ': ' + error.message);
    return null;
  }
}

async function postSheetApi(route, body) {
  const url = getSheetApiUrl(route);
  if (!url) return null;
  const payload = { ...body };
  if (process.env.TELEGRAM_API_KEY && !payload.apiKey) payload.apiKey = process.env.TELEGRAM_API_KEY;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const data = await response.json();
  if (!data || data.ok === false) throw new Error((data && data.error) || 'Sheet API request failed');
  return data.data || data;
}

function normalizeProduct(input) {
  const { title, price, type, desc, description, image, active, orderUrl } = input;
  if (!title || !price || !type) return null;
  return {
    id: input.id || Date.now(),
    title: String(title).trim(),
    price: String(price).trim(),
    type: String(type).trim(),
    desc: String(desc || description || '').trim(),
    image: image || null,
    active: active !== false,
    orderUrl: orderUrl || null,
    date: input.date || new Date().toISOString().split('T')[0]
  };
}

function normalizeProductForSite(product) {
  return { ...product, desc: product.desc || product.description || '', active: product.active !== false && product.status !== 'inactive' };
}

function normalizeCurrencyRate(input) {
  const { code, rate, change, name } = input;
  if (!code || rate === undefined || rate === null || rate === '') return null;
  const numericRate = Number(String(rate).replace(/,/g, ''));
  if (!Number.isFinite(numericRate)) return null;
  return {
    code: String(code).trim().toUpperCase(),
    name: name ? String(name).trim() : 'Myanmar Kyat',
    rate: numericRate,
    change: change ? String(change).trim() : '0%',
    updatedAt: new Date().toISOString()
  };
}

function normalizeCurrencyForSite(rate) {
  return {
    ...rate,
    code: String(rate.code || '').toUpperCase(),
    name: rate.name || 'Myanmar Kyat',
    rate: Number(rate.rate),
    change: rate.change || '0%'
  };
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.get('/solutions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'solutions.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/liveRepairs', async (req, res) => {
  try {
    const response = await fetch(GOOGLE_SHEETS_API + '?action=liveRepairs', { redirect: 'follow' });
    const data = await response.json();
    return res.json(Array.isArray(data) ? data : []);
  } catch (error) {
    console.error('Error fetching live repairs:', error.message);
    return res.json([]);
  }
});

app.get('/api/solutions', async (req, res) => {
  try {
    const sheetSolutions = await fetchSheetApi('/api/solutions', req.query.q ? { q: req.query.q } : {});
    if (Array.isArray(sheetSolutions)) {
      const activeSolutions = sheetSolutions.filter(s => s.active !== false && s.status !== 'inactive');
      if (req.query.q) {
        const keyword = req.query.q.toLowerCase().trim();
        return res.json(activeSolutions.filter(s =>
          String(s.title || '').toLowerCase().includes(keyword) ||
          String(s.description || '').toLowerCase().includes(keyword) ||
          String(s.category || '').toLowerCase().includes(keyword)
        ));
      }
      return res.json(activeSolutions);
    }

    const solutions = readJson(SOLUTIONS_FILE);
    if (req.query.q) {
      const keyword = req.query.q.toLowerCase().trim();
      return res.json(solutions.filter(s =>
        String(s.title || '').toLowerCase().includes(keyword) ||
        String(s.description || '').toLowerCase().includes(keyword) ||
        String(s.category || '').toLowerCase().includes(keyword)
      ));
    }
    return res.json(solutions);
  } catch (error) {
    console.error('Error reading solutions:', error.message);
    return res.json([]);
  }
});

async function createSolution(req, res) {
  try {
    const { title, description, category, author, image } = req.body;
    if (!title || !description || !category || !author) {
      return res.status(400).json({ error: true, message: 'Missing required fields: title, description, category, author' });
    }
    if (TELEGRAM_SHEET_API_URL) return res.json({ success: true, data: await postSheetApi('/solution', req.body) });
    const solutions = readJson(SOLUTIONS_FILE);
    const newSolution = {
      id: Date.now(),
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      author: author.trim(),
      image: image || null,
      date: new Date().toISOString().split('T')[0],
      likes: 0
    };
    solutions.unshift(newSolution);
    writeJson(SOLUTIONS_FILE, solutions);
    return res.json({ success: true, data: newSolution });
  } catch (error) {
    console.error('Error adding solution:', error.message);
    return res.status(500).json({ error: true, message: error.message });
  }
}

app.post('/api/solutions', requireTelegramKey, createSolution);
app.post('/api/solution', requireTelegramKey, createSolution);
app.post('/solution', requireTelegramKey, createSolution);

app.put('/api/solutions/:id/like', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const solutions = readJson(SOLUTIONS_FILE);
    const index = solutions.findIndex(s => Number(s.id) === id);
    if (index === -1) return res.status(404).json({ error: true, message: 'Solution not found' });
    solutions[index].likes = (solutions[index].likes || 0) + 1;
    writeJson(SOLUTIONS_FILE, solutions);
    return res.json({ success: true, likes: solutions[index].likes });
  } catch (error) {
    return res.status(500).json({ error: true, message: 'Internal server error' });
  }
});

app.get('/api/voucher/:voucher', async (req, res) => {
  try {
    const voucher = req.params.voucher.toUpperCase().trim();
    const response = await fetch(GOOGLE_SHEETS_API + '?action=voucher&id=' + encodeURIComponent(voucher), { redirect: 'follow' });
    return res.json(await response.json());
  } catch (error) {
    console.error('Error in voucher lookup:', error.message);
    return res.status(500).json({ error: true, message: 'Internal server error' });
  }
});

app.get('/api/currency', async (req, res) => {
  try {
    const sheetRates = await fetchSheetApi('/api/currency');
    if (Array.isArray(sheetRates)) return res.json(sheetRates.map(normalizeCurrencyForSite).filter(rate => rate.code && Number.isFinite(rate.rate)));
    const localRates = readJson(CURRENCY_FILE);
    if (Array.isArray(localRates) && localRates.length > 0) return res.json(localRates);
    const response = await fetch(GOOGLE_SHEETS_API + '?action=currency', { redirect: 'follow' });
    const data = await response.json();
    if (Array.isArray(data)) return res.json(data);
    throw new Error('Invalid response');
  } catch (error) {
    console.error('Error fetching currency:', error.message);
    return res.json([
      { code: 'USD', rate: 3520, change: '+0.5%' },
      { code: 'THB', rate: 98.5, change: '-0.2%' },
      { code: 'SGD', rate: 2610, change: '+0.1%' }
    ]);
  }
});

async function updateCurrency(req, res) {
  try {
    if (TELEGRAM_SHEET_API_URL) return res.json({ success: true, data: await postSheetApi('/currency', req.body) });
    const payload = Array.isArray(req.body) ? req.body : (Array.isArray(req.body.rates) ? req.body.rates : [req.body]);
    const incomingRates = payload.map(normalizeCurrencyRate).filter(Boolean);
    if (incomingRates.length === 0) return res.status(400).json({ error: true, message: 'Missing required fields: code, rate' });
    const existingRates = readJson(CURRENCY_FILE);
    const byCode = new Map(existingRates.map(rate => [String(rate.code || '').toUpperCase(), rate]));
    incomingRates.forEach(rate => byCode.set(rate.code, rate));
    const rates = Array.from(byCode.values()).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    writeJson(CURRENCY_FILE, rates);
    return res.json({ success: true, count: rates.length, data: rates });
  } catch (error) {
    console.error('Error updating currency:', error.message);
    return res.status(500).json({ error: true, message: error.message });
  }
}

app.post('/api/currency', requireTelegramKey, updateCurrency);
app.post('/currency', requireTelegramKey, updateCurrency);

app.get('/api/products', async (req, res) => {
  try {
    const sheetProducts = await fetchSheetApi('/api/products');
    if (Array.isArray(sheetProducts)) return res.json(sheetProducts.map(normalizeProductForSite).filter(product => product.active));
    return res.json(readJson(PRODUCTS_FILE).filter(product => product.active !== false));
  } catch (error) {
    console.error('Error reading products:', error.message);
    return res.json([]);
  }
});

async function createProduct(req, res) {
  try {
    if (TELEGRAM_SHEET_API_URL) return res.json({ success: true, data: await postSheetApi('/digital-product', req.body) });
    const newProduct = normalizeProduct(req.body);
    if (!newProduct) return res.status(400).json({ error: true, message: 'Missing required fields: title, price, type' });
    const products = readJson(PRODUCTS_FILE);
    const existingIndex = products.findIndex(product => Number(product.id) === Number(newProduct.id));
    if (existingIndex >= 0) products[existingIndex] = { ...products[existingIndex], ...newProduct };
    else products.unshift(newProduct);
    writeJson(PRODUCTS_FILE, products);
    return res.json({ success: true, data: newProduct });
  } catch (error) {
    console.error('Error adding product:', error.message);
    return res.status(500).json({ error: true, message: error.message });
  }
}

app.post('/api/products', requireTelegramKey, createProduct);
app.post('/api/product', requireTelegramKey, createProduct);
app.post('/product', requireTelegramKey, createProduct);
app.post('/digital-product', requireTelegramKey, createProduct);

app.get('/api/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.post('/webhook', (req, res) => {
  const event = req.headers['x-github-event'] || '';
  if (event === 'push') {
    require('child_process').exec('/usr/local/bin/deploy-web.sh', { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
      return res.json({ ok: true });
    });
  } else {
    res.json({ ok: true, msg: 'ignored: ' + event });
  }
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('Using Google Sheets API: ' + GOOGLE_SHEETS_API);
  console.log('Solutions data file: ' + SOLUTIONS_FILE);
});

module.exports = app;
