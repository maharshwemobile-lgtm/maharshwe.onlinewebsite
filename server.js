
app.get('/api/vpn-ads', (req, res) => {
  try {
    return res.json(normalizeVpnAdConfig(readJson(VPN_ADS_FILE, {})));
  } catch (error) {
    console.error('VPN ads config read error:', error.message);
    return res.json(normalizeVpnAdConfig({ enabled: false }));
  }
});

app.post('/api/vpn-ads', requireTelegramKey, (req, res) => {
  try {
    const config = normalizeVpnAdConfig({
      ...req.body,
      enabled: req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 'on',
      updatedAt: new Date().toISOString(),
    });
    writeJson(VPN_ADS_FILE, config);
    return res.json({ success: true, data: config });
  } catch (error) {
    console.error('VPN ads config write error:', error.message);
    return res.status(500).json({ error: true, message: error.message });
  }
});

app.use('/pos', express.static(path.join(__dirname, 'public', 'pos')));
app.get(/^\/pos(?:\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pos', 'index.html'));
});
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