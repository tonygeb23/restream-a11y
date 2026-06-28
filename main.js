// RestreamA11y — Electron main process
// Handles: window lifecycle, secure config/token storage, OAuth2 flow, and a
// thin proxy for Restream REST calls (so the renderer never touches secrets and
// we sidestep CORS).

const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Restream API constants. These are the documented v2 endpoints. If your dev
// docs say otherwise, this is the ONE place to adjust them.
// ---------------------------------------------------------------------------
const RESTREAM = {
  // Verified against developers.restream.io: the authorize dialog lives at
  // /login (NOT /login/oauth/authorize). Scopes are NOT passed here — Restream
  // currently grants whatever scopes are enabled on your app in the dev portal.
  authorizeUrl: 'https://api.restream.io/login',
  tokenUrl: 'https://api.restream.io/oauth/token',
  apiBase: 'https://api.restream.io/v2',
};

// Loopback redirect we listen on during OAuth. Must be registered in your
// Restream app settings as an allowed redirect URI.
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

let mainWindow = null;

// ---------------------------------------------------------------------------
// Config + token persistence (stored in the app's userData dir).
// Secrets are encrypted with the OS keychain via safeStorage when available.
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function tokenPath() {
  return path.join(app.getPath('userData'), 'tokens.enc');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return { clientId: '', clientSecret: '', tts: {} };
  }
}
function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function saveTokens(tokens) {
  const json = JSON.stringify(tokens);
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(tokenPath(), safeStorage.encryptString(json));
  } else {
    fs.writeFileSync(tokenPath(), json, 'utf8');
  }
}
function loadTokens() {
  try {
    const buf = fs.readFileSync(tokenPath());
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(buf));
    }
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}
function clearTokens() {
  try { fs.unlinkSync(tokenPath()); } catch {}
}

// ---------------------------------------------------------------------------
// OAuth2 authorization-code flow with a temporary loopback server.
// ---------------------------------------------------------------------------
function startOAuth() {
  return new Promise((resolve, reject) => {
    const cfg = readConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      reject(new Error('Missing Client ID / Client Secret. Enter them in Settings first.'));
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      const finish = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:sans-serif;padding:2rem">
          <h1>${msg}</h1><p>You can close this tab and return to RestreamA11y.</p>
          </body></html>`);
        server.close();
      };

      if (!code || returnedState !== state) {
        finish('Authorization failed.');
        reject(new Error('OAuth failed or state mismatch.'));
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(cfg, code);
        tokens.obtained_at = Date.now();
        saveTokens(tokens);
        finish('Connected! ✅');
        resolve(true);
      } catch (err) {
        finish('Token exchange failed.');
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      const authUrl = new URL(RESTREAM.authorizeUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', cfg.clientId);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('state', state);
      shell.openExternal(authUrl.toString());
    });

    server.on('error', reject);
  });
}

async function exchangeCodeForTokens(cfg, code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const resp = await fetch(RESTREAM.tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!resp.ok) throw new Error(`Token exchange HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function refreshTokens() {
  const cfg = readConfig();
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('No refresh token.');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const resp = await fetch(RESTREAM.tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!resp.ok) throw new Error(`Refresh HTTP ${resp.status}: ${await resp.text()}`);
  const next = await resp.json();
  next.obtained_at = Date.now();
  if (!next.refresh_token) next.refresh_token = tokens.refresh_token;
  saveTokens(next);
  return next;
}

async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Not connected.');
  const ageSec = (Date.now() - (tokens.obtained_at || 0)) / 1000;
  const expiresIn = tokens.expires_in || 3600;
  if (ageSec > expiresIn - 120) {
    tokens = await refreshTokens();
  }
  return tokens.access_token;
}

// Generic authenticated REST call against the Restream API.
async function apiCall(method, endpoint, body) {
  const token = await getValidAccessToken();
  const resp = await fetch(`${RESTREAM.apiBase}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) throw new Error(`API ${method} ${endpoint} → ${resp.status}: ${text}`);
  return data;
}

// ---------------------------------------------------------------------------
// IPC surface exposed to the renderer (via preload).
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => {
  const cfg = readConfig();
  // Never ship the secret to the renderer; just say whether one is set.
  return {
    clientId: cfg.clientId || '',
    hasClientSecret: !!cfg.clientSecret,
    tts: cfg.tts || {},
    connected: !!loadTokens(),
  };
});

ipcMain.handle('config:set', (_e, partial) => {
  const cfg = readConfig();
  if (typeof partial.clientId === 'string') cfg.clientId = partial.clientId.trim();
  if (typeof partial.clientSecret === 'string' && partial.clientSecret.length)
    cfg.clientSecret = partial.clientSecret.trim();
  if (partial.tts) cfg.tts = { ...cfg.tts, ...partial.tts };
  writeConfig(cfg);
  return true;
});

ipcMain.handle('auth:connect', async () => { await startOAuth(); return true; });
ipcMain.handle('auth:disconnect', () => { clearTokens(); return true; });
ipcMain.handle('auth:token', async () => getValidAccessToken());

ipcMain.handle('api:call', async (_e, { method, endpoint, body }) =>
  apiCall(method, endpoint, body));

// ---------------------------------------------------------------------------
// Azure Neural TTS proxy. Synthesis happens here (Node, no CORS); the renderer
// gets back base64 MP3 to play. Key never leaves the main process.
// ---------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

ipcMain.handle('azure:get', () => {
  const cfg = readConfig();
  const a = cfg.azure || {};
  return { region: a.region || '', voice: a.voice || 'en-US-AndrewMultilingualNeural', hasKey: !!a.key };
});

ipcMain.handle('azure:set', (_e, partial) => {
  const cfg = readConfig();
  cfg.azure = cfg.azure || {};
  if (typeof partial.region === 'string') cfg.azure.region = partial.region.trim();
  if (typeof partial.voice === 'string' && partial.voice) cfg.azure.voice = partial.voice;
  if (typeof partial.key === 'string' && partial.key.length) cfg.azure.key = partial.key.trim();
  writeConfig(cfg);
  return true;
});

ipcMain.handle('azure:voices', async () => {
  const a = readConfig().azure || {};
  if (!a.key || !a.region) throw new Error('Azure key/region not set.');
  const resp = await fetch(`https://${a.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': a.key },
  });
  if (!resp.ok) throw new Error(`Azure voices HTTP ${resp.status}: ${await resp.text()}`);
  return resp.json(); // [{ Name, ShortName, DisplayName, Gender, Locale, ... }]
});

// text + {voice, rate, pitch} → base64 MP3. rate/pitch are SSML strings like "+10%".
ipcMain.handle('azure:speak', async (_e, { text, voice, rate, pitch }) => {
  const a = readConfig().azure || {};
  if (!a.key || !a.region) throw new Error('Azure key/region not set.');
  const v = voice || a.voice || 'en-US-AndrewMultilingualNeural';
  const ssml =
    `<speak version='1.0' xml:lang='en-US'><voice name='${v}'>` +
    `<prosody rate='${rate || '+0%'}' pitch='${pitch || '+0%'}'>${xmlEscape(text)}</prosody>` +
    `</voice></speak>`;
  const resp = await fetch(`https://${a.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': a.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'RestreamA11y',
    },
    body: ssml,
  });
  if (!resp.ok) throw new Error(`Azure TTS HTTP ${resp.status}: ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString('base64');
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 560,
    title: 'RestreamA11y',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu(); // we provide our own keyboard shortcuts in-app
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
