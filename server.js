const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    if (key) process.env[key] = value;
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
const NOTIFICATION_TOKENS_FILE = path.join(DATA_DIR, 'notification_tokens.json');
const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads');
const SOLUTION_UPLOAD_DIR = path.join(UPLOAD_ROOT, 'solutions');
const PRODUCT_UPLOAD_DIR = path.join(UPLOAD_ROOT, 'products');
const DEFAULT_FCM_TOPIC = process.env.FCM_TOPIC || 'maharshwe-vpn';

for (const dir of [DATA_DIR, SOLUTION_UPLOAD_DIR, PRODUCT_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
for (const file of [SOLUTIONS_FILE, CURRENCY_FILE, PRODUCTS_FILE, NOTIFICATION_TOKENS_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const firebaseTokenCache = { accessToken: '', expiresAt: 0 };

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizeFirebasePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function getFirebaseConfig() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
  };
}

function getMissingFirebaseConfig(config) {
  return ['projectId', 'clientEmail', 'privateKey'].filter(key => !config[key]);
}

async function getFirebaseAccessToken(config) {
  if (firebaseTokenCache.accessToken && firebaseTokenCache.expiresAt > Date.now() + 60000) {
    return firebaseTokenCache.accessToken;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsignedJwt = `${header}.${claim}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsignedJwt)
    .sign(config.privateKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedJwt}.${signature}`,
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Firebase auth failed');
  }

  firebaseTokenCache.accessToken = data.access_token;
  firebaseTokenCache.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return firebaseTokenCache.accessToken;
}

async function sendFirebaseTopicNotification({ title, body, url, topic }) {
  const config = getFirebaseConfig();
  const missing = getMissingFirebaseConfig(config);
  if (missing.length > 0) {
    const error = new Error('Firebase config missing: ' + missing.join(', '));
    error.status = 501;
    throw error;
  }

  const accessToken = await getFirebaseAccessToken(config);
  const targetTopic = String(topic || DEFAULT_FCM_TOPIC).replace(/^\/topics\//, '').trim() || DEFAULT_FCM_TOPIC;
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          topic: targetTopic,
          notification: { title, body },
          data: {
            url: url || 'https://maharshwe.online/vpn',
            topic: targetTopic,
          },
          android: {
            priority: 'HIGH',
            notification: {
              icon: 'small_icon',
              color: '#ff9f19',
            },
          },
          webpush: {
            fcm_options: { link: url || 'https://maharshwe.online/vpn' },
          },
        },
      }),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || 'Firebase send failed');
  }
  return data;
}

function requireTelegramKey(req, res, next) {
  const expectedKey = process.env.TELEGRAM_API_KEY;
  if (!expectedKey) return next();
  const providedKey = req.get('x-api-key') || req.query.key || req.body.apiKey || req.body.api_key || '';
  if (providedKey !== expectedKey) return res.status(401).json({ error: true, message: 'Invalid API key' });
  next();
}

function isImageValue(value) {
  return /^(https?:\/\/|\/uploads\/|data:image\/)/i.test(String(value || ''));
}

function mapImageField(item) {
  const fields = ['image', 'imagePath', 'photo', 'imageUrl', 'image_url', 'picture', 'thumbnail', 'cover'];
  for (const field of fields) {
    if (item && item[field] && isImageValue(item[field])) return { url: item[field], source: field };
  }
  return { url: null, source: 'placeholder' };
}

function saveUploadedImage(imageData, originalName, type) {
  const match = String(imageData || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!match) throw new Error('Invalid image data. Please upload PNG, JPG, WEBP, or GIF.');

  const extension = match[1].toLowerCase().replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Image is too large. Maximum size is 5MB.');

  const safeName = String(originalName || type)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || type;
  const fileName = `${Date.now()}-${safeName}.${extension}`;
  const folder = type === 'product' ? PRODUCT_UPLOAD_DIR : SOLUTION_UPLOAD_DIR;
  const urlPath = type === 'product' ? 'products' : 'solutions';
  fs.writeFileSync(path.join(folder, fileName), buffer);
  return `/uploads/${urlPath}/${fileName}`;
}

function applyInlineImageUpload(body, type) {
  if (!body || !body.imageData) return { ...body };
  const image = saveUploadedImage(body.imageData, body.fileName || body.imageFileName || body.title, type);
  const { imageData, fileName, imageFileName, ...rest } = body;
  return { ...rest, image };
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
  const { title, price, type, desc, description, active, orderUrl } = input;
  const mappedImage = mapImageField(input);
  if (!title || !price || !type) return null;
  return {
    id: input.id || Date.now(),
    title: String(title).trim(),
    price: String(price).trim(),
    type: String(type).trim(),
    desc: String(desc || description || '').trim(),
    image: mappedImage.url,
    imageMapping: mappedImage.source,
    active: active !== false,
    orderUrl: orderUrl || null,
    date: input.date || new Date().toISOString().split('T')[0]
  };
}

function normalizeProductForSite(product) {
  const mappedImage = mapImageField(product);
  return {
    ...product,
    desc: product.desc || product.description || '',
    image: mappedImage.url,
    imageMapping: product.imageMapping || mappedImage.source,
    active: product.active !== false && product.status !== 'inactive'
  };
}

function normalizeSolution(input) {
  const { title, description, category, author, active } = input;
  const mappedImage = mapImageField(input);
  if (!title || !description || !category || !author) return null;
  return {
    id: input.id || Date.now(),
    title: String(title).trim(),
    description: String(description).trim(),
    category: String(category).trim(),
    author: String(author).trim(),
    image: mappedImage.url,
    imageMapping: mappedImage.source,
    active: active !== false,
    date: input.date || new Date().toISOString().split('T')[0],
    likes: Number(input.likes || 0)
  };
}

function normalizeSolutionForSite(solution) {
  const mappedImage = mapImageField(solution);
  return {
    ...solution,
    id: solution.id || solution.ID || solution.solution_id || Date.now(),
    title: solution.title || solution.Title || '',
    description: solution.description || solution.desc || solution.Description || '',
    category: solution.category || solution.Category || 'Tips',
    author: solution.author || solution.Author || 'Admin',
    image: mappedImage.url,
    imageMapping: solution.imageMapping || mappedImage.source,
    active: solution.active !== false && solution.status !== 'inactive',
    likes: Number(solution.likes || 0),
    date: solution.date || solution.created_at || solution.createdAt || ''
  };
}

function firstValue(item, keys, fallback = '') {
  for (const key of keys) {
    if (item && item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key];
  }
  return fallback;
}

function normalizeLiveRepairForSite(item) {
  return {
    ...item,
    voucher: firstValue(item, ['voucher', 'repairId', 'repairID', 'RepairID', 'Repair ID', 'id', 'ID'], '-'),
    model: firstValue(item, ['model', 'Model', 'phone', 'device'], '-'),
    customer: firstValue(item, ['customer', 'owner', 'ownerName', 'Customer', 'name'], '-'),
    issue: firstValue(item, ['issue', 'repairType', 'problem', 'Issue'], '-'),
    staff: firstValue(item, ['staff', 'staffName', 'serviceStaff', 'technician', 'Technician', 'Staff', 'Staff Name', 'တာဝန်ခံ', 'ဆားဗစ်ဆရာ'], '-'),
    shop: firstValue(item, ['shop', 'shopName', 'Shop'], 'Mahar Shwe Mobile'),
    status: firstValue(item, ['status', 'Status', 'repairStatus'], 'စောင့်ဆိုင်းနေဆဲ'),
    updatedAt: firstValue(item, ['updatedAt', 'updated_at', 'date', 'Date'], '')
  };
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

function mergeByKey(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter(item => {
    const key = String(item.id || item.title || '') + '|' + String(item.date || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return item.active !== false;
  });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.get('/solutions', (req, res) => res.sendFile(path.join(__dirname, 'public', 'solutions.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/notifications/register', (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: true, message: 'Missing FCM token' });
    }

    const tokens = readJson(NOTIFICATION_TOKENS_FILE);
    const existingIndex = tokens.findIndex(item => item.token === token);
    const record = {
      token,
      platform: String(req.body.platform || 'android').trim(),
      topic: String(req.body.topic || DEFAULT_FCM_TOPIC).trim(),
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) {
      tokens[existingIndex] = { ...tokens[existingIndex], ...record };
    } else {
      tokens.push({ ...record, createdAt: record.updatedAt });
    }
    writeJson(NOTIFICATION_TOKENS_FILE, tokens);
    return res.json({ success: true, topic: record.topic });
  } catch (error) {
    console.error('Notification registration error:', error.message);
    return res.status(500).json({ error: true, message: 'Internal server error' });
  }
});

app.post('/api/notifications/send', requireTelegramKey, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    const url = String(req.body.url || 'https://maharshwe.online/vpn').trim();
    const topic = String(req.body.topic || DEFAULT_FCM_TOPIC).trim();
    if (!title || !body) {
      return res.status(400).json({ error: true, message: 'Title and message are required' });
    }

    const result = await sendFirebaseTopicNotification({ title, body, url, topic });
    return res.json({ success: true, topic, result });
  } catch (error) {
    console.error('Notification send error:', error.message);
    return res.status(error.status || 500).json({ error: true, message: error.message });
  }
});

app.get('/api/liveRepairs', async (req, res) => {
  try {
    const response = await fetch(GOOGLE_SHEETS_API + '?action=liveRepairs', { redirect: 'follow' });
    const data = await response.json();
    return res.json(Array.isArray(data) ? data.map(normalizeLiveRepairForSite) : []);
  } catch (error) {
    console.error('Error fetching live repairs:', error.message);
    return res.json([]);
  }
});

app.get('/api/solutions', async (req, res) => {
  try {
    const sheetSolutions = await fetchSheetApi('/api/solutions', req.query.q ? { q: req.query.q } : {});
    const localSolutions = readJson(SOLUTIONS_FILE).map(normalizeSolutionForSite).filter(solution => solution.active);
    let solutions = localSolutions;
    if (Array.isArray(sheetSolutions)) {
      solutions = mergeByKey(localSolutions, sheetSolutions.map(normalizeSolutionForSite).filter(solution => solution.active));
    }
    if (req.query.q) {
      const keyword = req.query.q.toLowerCase().trim();
      solutions = solutions.filter(s =>
        String(s.title || '').toLowerCase().includes(keyword) ||
        String(s.description || '').toLowerCase().includes(keyword) ||
        String(s.category || '').toLowerCase().includes(keyword)
      );
    }
    return res.json(solutions);
  } catch (error) {
    console.error('Error reading solutions:', error.message);
    return res.json([]);
  }
});

async function createSolution(req, res) {
  try {
    const body = applyInlineImageUpload(req.body, 'solution');
    const newSolution = normalizeSolution(body);
    if (!newSolution) return res.status(400).json({ error: true, message: 'Missing required fields: title, description, category, author' });

    const solutions = readJson(SOLUTIONS_FILE);
    solutions.unshift(newSolution);
    writeJson(SOLUTIONS_FILE, solutions);

    if (TELEGRAM_SHEET_API_URL) {
      try { await postSheetApi('/solution', newSolution); }
      catch (error) { console.warn('Sheet API solution post failed, local copy saved: ' + error.message); }
    }
    return res.json({ success: true, data: newSolution });
  } catch (error) {
    console.error('Error adding solution:', error.message);
    return res.status(500).json({ error: true, message: error.message });
  }
}

app.post('/api/uploads/solution-image', requireTelegramKey, (req, res) => {
  try { return res.json({ success: true, image: saveUploadedImage(req.body.imageData, req.body.fileName, 'solution') }); }
  catch (error) { return res.status(400).json({ error: true, message: error.message }); }
});

app.post('/api/uploads/product-image', requireTelegramKey, (req, res) => {
  try { return res.json({ success: true, image: saveUploadedImage(req.body.imageData, req.body.fileName, 'product') }); }
  catch (error) { return res.status(400).json({ error: true, message: error.message }); }
});

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
app.post('/ငွေစျေး', requireTelegramKey, updateCurrency);

app.get('/api/products', async (req, res) => {
  try {
    const sheetProducts = await fetchSheetApi('/api/products');
    if (Array.isArray(sheetProducts)) return res.json(sheetProducts.map(normalizeProductForSite).filter(product => product.active));
    return res.json(readJson(PRODUCTS_FILE).map(normalizeProductForSite).filter(product => product.active));
  } catch (error) {
    console.error('Error reading products:', error.message);
    return res.json([]);
  }
});

async function createProduct(req, res) {
  try {
    const body = applyInlineImageUpload(req.body, 'product');
    const newProduct = normalizeProduct(body);
    if (!newProduct) return res.status(400).json({ error: true, message: 'Missing required fields: title, price, type' });

    const products = readJson(PRODUCTS_FILE);
    const existingIndex = products.findIndex(product => Number(product.id) === Number(newProduct.id));
    if (existingIndex >= 0) products[existingIndex] = { ...products[existingIndex], ...newProduct };
    else products.unshift(newProduct);
    writeJson(PRODUCTS_FILE, products);

    if (TELEGRAM_SHEET_API_URL) {
      try { await postSheetApi('/digital-product', newProduct); }
      catch (error) { console.warn('Sheet API product post failed, local copy saved: ' + error.message); }
    }

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

app.get('/auth/telegram', (req, res) => {  const name = req.query.first_name || req.query.username || 'Telegram User';});
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
