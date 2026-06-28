// Standalone status check: decrypts the stored token with the SAME mechanism the
// app uses (Electron safeStorage / DPAPI), then exercises each authenticated
// endpoint and prints a report. Run with: npx electron verify.js
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

// Match the real app's userData dir (electron defaults to "Electron" for a
// loose script, but the app runs as "restream-a11y").
app.setName('restream-a11y');

const API = 'https://api.restream.io/v2';
const TOKEN_URL = 'https://api.restream.io/oauth/token';

function dir() { return app.getPath('userData'); }
function readConfig() { return JSON.parse(fs.readFileSync(path.join(dir(), 'config.json'), 'utf8')); }
function loadTokens() {
  const buf = fs.readFileSync(path.join(dir(), 'tokens.enc'));
  if (safeStorage.isEncryptionAvailable()) return JSON.parse(safeStorage.decryptString(buf));
  return JSON.parse(buf.toString('utf8'));
}
function saveTokens(t) {
  const json = JSON.stringify(t);
  fs.writeFileSync(path.join(dir(), 'tokens.enc'),
    safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
}

async function refreshIfNeeded(cfg, tokens) {
  const ageSec = (Date.now() - (tokens.obtained_at || 0)) / 1000;
  if (ageSec < (tokens.expires_in || 3600) - 120) return tokens;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const next = await r.json();
  next.obtained_at = Date.now();
  if (!next.refresh_token) next.refresh_token = tokens.refresh_token;
  saveTokens(next);
  console.log('  (access token was refreshed)');
  return next;
}

async function get(token, ep) {
  const r = await fetch(API + ep, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

app.whenReady().then(async () => {
  const out = [];
  try {
    const cfg = readConfig();
    let tokens = loadTokens();
    out.push(`Token decrypted OK. Scopes granted: ${tokens.scope || '(not reported)'}`);
    tokens = await refreshIfNeeded(cfg, tokens);
    const token = tokens.access_token;

    const profile = await get(token, '/user/profile');
    out.push(`\n[profile.read]  GET /user/profile → HTTP ${profile.status}`);
    if (profile.ok) out.push(`  username: ${profile.data.username}   email: ${profile.data.email}   id: ${profile.data.id}`);
    else out.push(`  ${JSON.stringify(profile.data)}`);

    const channels = await get(token, '/user/channel/all');
    out.push(`\n[channels.read] GET /user/channel/all → HTTP ${channels.status}`);
    if (channels.ok) {
      const list = Array.isArray(channels.data) ? channels.data : [];
      out.push(`  ${list.length} channel(s):`);
      const plats = await get(token, '/platform/all');
      const pmap = {}; if (plats.ok) for (const p of plats.data) pmap[p.id] = p.name;
      for (const ch of list)
        out.push(`    • ${ch.displayName || '(no name)'} — ${pmap[ch.streamingPlatformId] || ch.streamingPlatformId} — ${ch.active ? 'ON' : 'off'}`);
    } else out.push(`  ${JSON.stringify(channels.data)}`);

    const key = await get(token, '/user/streamKey');
    out.push(`\n[stream.read]   GET /user/streamKey → HTTP ${key.status}`);
    if (key.ok) {
      const k = key.data.streamKey || '';
      out.push(`  streamKey: ${k ? k.slice(0, 6) + '…' + k.slice(-4) : '(none)'}   srtUrl: ${key.data.srtUrl ?? 'null'}`);
    } else out.push(`  ${JSON.stringify(key.data)}`);

  } catch (e) {
    out.push('ERROR: ' + e.message);
  }
  console.log('\n===== RESTREAM LIVE STATUS =====\n' + out.join('\n') + '\n================================');
  app.quit();
});
