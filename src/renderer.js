/* RestreamA11y — renderer / UI logic.
 *
 * Sections:
 *   1. Live-region announce helpers
 *   2. Tab navigation (roving tabindex + Ctrl+digit + global keys)
 *   3. Settings / OAuth wiring
 *   4. Restream REST features (profile, status, key, channels, title)
 *   5. Chat WebSocket
 *   6. TTS (Web Speech API) with voice/rate/pitch/volume controls
 *
 * ENDPOINT MAP — all verified against developers.restream.io (June 2026).
 */
const EP = {
  profile:      '/user/profile',                      // scope profile.read  → {id,username,email}
  channelsAll:  '/user/channel/all',                  // scope channels.read
  channel:      (id) => `/user/channel/${id}`,        // PATCH {active}      scope channels.write
  channelDelete:(id) => `/user/channels/${id}`,       // DELETE (note PLURAL) 204; scope channels.write
  channelMeta:  (id) => `/user/channel-meta/${id}`,   // PATCH {title,description} scope channels.write
  streamKey:    '/user/streamKey',                    // scope stream.read   → {streamKey,srtUrl}
  platformsAll: '/platform/all',                      // public; maps streamingPlatformId → name
};

// Streaming status WebSocket — pushes live/offline state in real time.
const STREAMING_WS = (token) =>
  `wss://streaming.api.restream.io/ws?accessToken=${encodeURIComponent(token)}`;

const api = window.restream;

// ---------------------------------------------------------------------------
// 1. Announcements
// ---------------------------------------------------------------------------
const liveStatus = document.getElementById('liveStatus');
const liveAlert = document.getElementById('liveAlert');
function announce(msg) { liveStatus.textContent = ''; requestAnimationFrame(() => liveStatus.textContent = msg); }
function alertMsg(msg) { liveAlert.textContent = ''; requestAnimationFrame(() => liveAlert.textContent = msg); }

// ---------------------------------------------------------------------------
// 2. Tabs
// ---------------------------------------------------------------------------
const tablist = document.getElementById('tablist');
const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));

function selectTab(index, focus = true) {
  tabs.forEach((tab, i) => {
    const selected = i === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panels[i].hidden = !selected;
  });
  if (focus) tabs[index].focus();
  announce(`${tabs[index].textContent.trim()} tab`);
}

tablist.addEventListener('keydown', (e) => {
  const current = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (current + 1) % tabs.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  if (next !== null) { e.preventDefault(); selectTab(next); }
});
tabs.forEach((tab, i) => tab.addEventListener('click', () => selectTab(i, false)));

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  // Ctrl+1..6 → jump to tab
  if (e.ctrlKey && e.key >= '1' && e.key <= '6') {
    e.preventDefault();
    selectTab(Number(e.key) - 1);
    return;
  }
  // Esc → stop speech
  if (e.key === 'Escape') { stopSpeaking(); return; }

  // The rest only fire when not typing in a field
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (typing) return;

  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  if (e.key.toLowerCase() === 'r') { e.preventDefault(); refreshStatus(); }
});

function showShortcuts() {
  const text = [
    'Keyboard shortcuts:',
    'Ctrl+1 to Ctrl+6 — switch between tabs',
    'Arrow keys — move between tabs when a tab is focused',
    'R — refresh live status',
    'Esc — stop speaking',
    'Space — toggle a channel switch or checkbox',
    'Question mark — this list',
  ].join('. ');
  announce(text);
  alert(text.replace(/\. /g, '\n'));
}

// ---------------------------------------------------------------------------
// 3. Settings / OAuth
// ---------------------------------------------------------------------------
const connState = document.getElementById('connState');
const els = {
  clientId: document.getElementById('clientId'),
  clientSecret: document.getElementById('clientSecret'),
  credForm: document.getElementById('credForm'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
};

function setConnected(connected) {
  connState.textContent = connected ? 'Connected' : 'Not connected';
  connState.classList.toggle('connected', connected);
}

async function loadConfig() {
  const cfg = await api.getConfig();
  els.clientId.value = cfg.clientId || '';
  if (cfg.hasClientSecret) els.clientSecret.placeholder = '•••••• (saved — leave blank to keep)';
  setConnected(cfg.connected);
  applyTtsConfig(cfg.tts || {});
  if (cfg.connected) loadProfile();
}

els.credForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api.setConfig({ clientId: els.clientId.value, clientSecret: els.clientSecret.value });
  els.clientSecret.value = '';
  announce('Credentials saved.');
});

els.connectBtn.addEventListener('click', async () => {
  try {
    announce('Opening browser to sign in to Restream…');
    await api.connect();
    setConnected(true);
    announce('Connected to Restream.');
    loadProfile();
  } catch (err) { alertMsg('Connection failed: ' + err.message); }
});

els.disconnectBtn.addEventListener('click', async () => {
  await api.disconnect();
  setConnected(false);
  announce('Disconnected.');
});

// ---------------------------------------------------------------------------
// 4. REST features
// ---------------------------------------------------------------------------
async function call(method, endpoint, body) {
  try {
    return await api.api(method, endpoint, body);
  } catch (err) {
    alertMsg('Request failed: ' + err.message);
    throw err;
  }
}

async function loadProfile() {
  try {
    const p = await call('GET', EP.profile);
    document.getElementById('profileInfo').textContent =
      `${p.username || p.displayName || 'Account'} — ${p.email || ''}`.trim();
  } catch {}
}

// Live status is pushed over the streaming WebSocket. The "Refresh status"
// button just (re)opens the socket; updates then arrive in real time.
let statusWs = null;
function setLiveIndicator(live) {
  const el = document.getElementById('liveIndicator');
  el.textContent = live ? '🔴 You are LIVE' : '⚪ Offline';
}
async function refreshStatus() {
  const el = document.getElementById('liveIndicator');
  el.textContent = 'Connecting…';
  try {
    const token = await api.getToken();
    if (statusWs) { try { statusWs.close(); } catch {} }
    statusWs = new WebSocket(STREAMING_WS(token));
    statusWs.addEventListener('open', () => { el.textContent = '⚪ Offline'; });
    statusWs.addEventListener('message', (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      // IStatusesUpdated carries online state. Shape varies, so dig defensively:
      const p = data.payload ?? data;
      let live = null;
      if (typeof p.online === 'boolean') live = p.online;
      else if (Array.isArray(p)) live = p.some(s => s && s.online);
      else if (Array.isArray(p.statuses)) live = p.statuses.some(s => s && s.online);
      if (live !== null) { setLiveIndicator(live); announce(live ? 'You are live.' : 'You are offline.'); }
    });
    statusWs.addEventListener('error', () => { el.textContent = 'Status unavailable'; });
  } catch {
    el.textContent = 'Status unavailable';
  }
}
document.getElementById('refreshStatus').addEventListener('click', refreshStatus);

document.getElementById('loadKey').addEventListener('click', async () => {
  const dl = document.getElementById('keyInfo');
  dl.innerHTML = '';
  try {
    const k = await call('GET', EP.streamKey);
    const rows = Object.entries(k || {});
    for (const [key, val] of rows) {
      const dt = document.createElement('dt'); dt.textContent = key;
      const dd = document.createElement('dd'); dd.textContent = String(val);
      dl.append(dt, dd);
    }
    announce('Stream key loaded.');
  } catch {}
});

// ---- Channels ----
const channelList = document.getElementById('channelList');

// streamingPlatformId (a number) → human name, loaded once from the public list.
let platformMap = {};
async function ensurePlatformMap() {
  if (Object.keys(platformMap).length) return;
  try {
    const platforms = await call('GET', EP.platformsAll);
    for (const p of platforms || []) platformMap[p.id] = p.name;
  } catch { /* non-fatal; we'll just show the id */ }
}

async function loadChannels() {
  channelList.innerHTML = '<li class="hint">Loading…</li>';
  try {
    await ensurePlatformMap();
    const channels = await call('GET', EP.channelsAll);
    channelList.innerHTML = '';
    if (!channels || !channels.length) {
      channelList.innerHTML = '<li class="hint">No channels found.</li>';
      return;
    }
    for (const ch of channels) renderChannel(ch);
    announce(`${channels.length} channels loaded.`);
  } catch {
    channelList.innerHTML = '<li class="hint">Could not load channels.</li>';
  }
}

function renderChannel(ch) {
  const li = document.createElement('li');
  li.className = 'channel-item';
  const id = ch.id;
  const platform = platformMap[ch.streamingPlatformId] || `Platform ${ch.streamingPlatformId ?? '?'}`;
  const name = ch.displayName || platform || `Channel ${id}`;
  const active = !!ch.active;

  const info = document.createElement('div');
  info.innerHTML = `<div class="channel-name">${escapeHtml(name)}</div>
    <div class="channel-platform">${escapeHtml(platform)}</div>`;

  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = active;
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', `${name} enabled`);
  const track = document.createElement('span'); track.className = 'track';
  const thumb = document.createElement('span'); thumb.className = 'thumb';
  track.appendChild(thumb);
  const stateText = document.createElement('span');
  stateText.className = 'state-text';
  stateText.textContent = active ? 'On' : 'Off';

  input.addEventListener('change', async () => {
    const want = input.checked;
    input.disabled = true;
    try {
      await call('PATCH', EP.channel(id), { active: want });
      stateText.textContent = want ? 'On' : 'Off';
      announce(`${name} turned ${want ? 'on' : 'off'}.`);
    } catch {
      input.checked = !want; // revert on failure
      stateText.textContent = input.checked ? 'On' : 'Off';
    } finally { input.disabled = false; }
  });

  label.append(input, track, stateText);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger-outline';
  delBtn.type = 'button';
  delBtn.textContent = 'Delete';
  delBtn.setAttribute('aria-label', `Delete ${name} channel`);
  delBtn.addEventListener('click', async () => {
    const ok = await confirmDelete(name);
    if (!ok) return;
    delBtn.disabled = true; input.disabled = true;
    try {
      await call('DELETE', EP.channelDelete(id));   // 204 No Content on success
      li.remove();
      announce(`${name} channel deleted.`);
    } catch {
      delBtn.disabled = false; input.disabled = false;
      alertMsg(`Could not delete ${name}.`);
    }
  });

  const controls = document.createElement('div');
  controls.className = 'channel-controls';
  controls.append(label, delBtn);
  li.append(info, controls);
  channelList.appendChild(li);
}

// ---- Accessible destructive confirmation ----
// Returns a Promise<boolean>. Uses native <dialog> modal (auto focus-trap + Esc).
const confirmDialog = document.getElementById('confirmDialog');
const confirmDesc = document.getElementById('confirmDesc');
const confirmDeleteBtn = document.getElementById('confirmDelete');
const confirmCancelBtn = document.getElementById('confirmCancel');

function confirmDelete(name) {
  return new Promise((resolve) => {
    confirmDesc.textContent =
      `Permanently delete "${name}"? This disconnects it from Restream and cannot be undone.`;
    const opener = document.activeElement; // restore focus here afterward

    const done = (result) => {
      confirmDeleteBtn.removeEventListener('click', onYes);
      confirmCancelBtn.removeEventListener('click', onNo);
      confirmDialog.removeEventListener('cancel', onCancel);
      if (confirmDialog.open) confirmDialog.close();
      if (opener && opener.focus) opener.focus();
      resolve(result);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    const onCancel = (e) => { e.preventDefault(); done(false); }; // Esc

    confirmDeleteBtn.addEventListener('click', onYes);
    confirmCancelBtn.addEventListener('click', onNo);
    confirmDialog.addEventListener('cancel', onCancel);

    confirmDialog.showModal();
    confirmCancelBtn.focus(); // safe default: focus Cancel, not Delete
  });
}
document.getElementById('reloadChannels').addEventListener('click', loadChannels);

// ---- Title & description ----
document.getElementById('titleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('streamTitle').value.trim();
  const description = document.getElementById('streamDesc').value.trim();
  const state = document.getElementById('titleSaveState');
  state.className = 'save-state';
  state.textContent = 'Saving…';
  try {
    // Apply to every channel's meta. (If your docs expose a single global
    // title endpoint, swap this loop for that one call.)
    const channels = await call('GET', EP.channelsAll);
    for (const ch of channels) {
      await call('PATCH', EP.channelMeta(ch.id), { title, description });
    }
    state.textContent = 'Saved ✓';
    state.classList.add('ok');
    announce('Title and description updated.');
  } catch {
    state.textContent = 'Could not save.';
    state.classList.add('err');
  }
});

// ---------------------------------------------------------------------------
// 5. Chat WebSocket
// ---------------------------------------------------------------------------
let chatWs = null;
const chatLog = document.getElementById('chatLog');
const connectChatBtn = document.getElementById('connectChat');
const disconnectChatBtn = document.getElementById('disconnectChat');

async function connectChat() {
  try {
    const token = await api.getToken();
    // Restream chat monitor WebSocket. Adjust if your docs specify another URL.
    chatWs = new WebSocket(`wss://chat.api.restream.io/ws?accessToken=${encodeURIComponent(token)}`);
    chatWs.addEventListener('open', () => {
      connectChatBtn.disabled = true;
      disconnectChatBtn.disabled = false;
      announce('Chat connected.');
    });
    chatWs.addEventListener('message', (ev) => handleChatMessage(ev.data));
    chatWs.addEventListener('close', () => {
      connectChatBtn.disabled = false;
      disconnectChatBtn.disabled = true;
      announce('Chat disconnected.');
    });
    chatWs.addEventListener('error', () => alertMsg('Chat connection error.'));
  } catch (err) { alertMsg('Could not connect chat: ' + err.message); }
}
function disconnectChat() { if (chatWs) chatWs.close(); chatWs = null; }
connectChatBtn.addEventListener('click', connectChat);
disconnectChatBtn.addEventListener('click', disconnectChat);

// Push a realistic message through the REAL parse → render → speak path so you
// can confirm announcements work without being live. Shape mirrors live data.
document.getElementById('testChat').addEventListener('click', () => {
  handleChatMessage(JSON.stringify({
    action: 'event',
    payload: {
      connectionIdentifier: '4445906-youtube-test',
      eventPayload: { author: { displayName: 'TestViewer' }, text: 'Hey, this is a test chat message!' },
    },
    timestamp: 0,
  }));
});

// Verified against live data: frames are { action, payload, timestamp }.
// Control frames ("heartbeat", "connection_info") carry no chat text and are
// skipped. Real chat messages arrive as action "event" with the author/text
// either under payload(.eventPayload) or, on some platforms, flattened.
function handleChatMessage(raw) {
  let data; try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (data.action === 'heartbeat' || data.action === 'connection_info') return;

  const payload = data.payload || data;
  const ep = payload.eventPayload || payload;
  const author =
    ep.author?.displayName || ep.author?.name || ep.displayName || ep.username || ep.from || 'Someone';
  const text =
    ep.text || ep.message || ep.body || '';
  if (!text) return; // not a text message (follow/sub/raid/etc.) — skip for now

  // Platform from "userId-platform-channelId" (e.g. ...-youtube-...), else fallbacks.
  let platform = '';
  const ci = payload.connectionIdentifier || ep.connectionIdentifier || '';
  if (ci && String(ci).split('-').length >= 2) platform = String(ci).split('-')[1];
  else platform = payload.eventSourceName || ep.eventSourceName || '';

  addChatMessage(author, text, platform);
}

function addChatMessage(author, text, platform) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML =
    `<span class="author">${escapeHtml(author)}</span>` +
    (platform ? `<span class="platform">${escapeHtml(String(platform))}</span>` : '') +
    `<span class="text">${escapeHtml(text)}</span>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  // Trim DOM so a long stream doesn't bloat memory / the a11y tree.
  while (chatLog.children.length > 200) chatLog.removeChild(chatLog.firstChild);

  if (document.getElementById('ttsChatToggle').checked) {
    speakMessage(author, text);
  }
}

// ---------------------------------------------------------------------------
// 6. TTS
// ---------------------------------------------------------------------------
const synth = window.speechSynthesis;
let voices = [];
const voiceSelect = document.getElementById('voiceSelect');
const rate = document.getElementById('rate');
const pitch = document.getElementById('pitch');
const volume = document.getElementById('volume');
const speakAuthor = document.getElementById('speakAuthor');
const engineSelect = document.getElementById('engineSelect');
const engineHint = document.getElementById('engineHint');
const reloadAzureVoicesBtn = document.getElementById('reloadAzureVoices');

let engine = 'system';          // 'system' | 'azure'
let azureVoiceList = [];        // [{ShortName, DisplayName, Gender, Locale}]
let azureSavedVoice = 'en-US-AndrewMultilingualNeural';

function loadVoices() {
  voices = synth.getVoices();
  // Sort natural/neural/online voices to the top — these are the good ones.
  const score = (v) => /natural|neural|online/i.test(v.name) ? 0 : 1;
  voices.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  voiceSelect.innerHTML = '';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.name;
    const tag = /natural|neural|online/i.test(v.name) ? ' ⭐' : '';
    opt.textContent = `${v.name} (${v.lang})${tag}`;
    voiceSelect.appendChild(opt);
  }
  applySavedVoiceSelection();
}

// Resolve a saved preference to an actual installed voice: exact name first,
// then a case-insensitive substring (so "Mark" or "Andrew" matches the full
// "Microsoft Mark - English (United States)" style names, and a neural voice
// added later auto-matches without reconfiguring).
function resolveVoiceName(pref) {
  if (!pref || !voices.length) return null;
  const exact = voices.find(v => v.name === pref);
  if (exact) return exact.name;
  const p = pref.toLowerCase();
  const partial = voices.find(v => v.name.toLowerCase().includes(p));
  return partial ? partial.name : null;
}
function applySavedVoiceSelection() {
  const resolved = resolveVoiceName(savedVoiceName);
  if (resolved) voiceSelect.value = resolved;
}
synth.addEventListener('voiceschanged', loadVoices);
loadVoices();

let savedVoiceName = null;
function applyTtsConfig(tts) {
  if (tts.voice) { savedVoiceName = tts.voice; applySavedVoiceSelection(); }
  if (tts.rate != null) rate.value = tts.rate;
  if (tts.pitch != null) pitch.value = tts.pitch;
  if (tts.volume != null) volume.value = tts.volume;
  if (tts.speakAuthor != null) speakAuthor.checked = tts.speakAuthor;
  if (tts.engine) { engine = tts.engine; engineSelect.value = tts.engine; }
  updateOutputs();
}

function updateOutputs() {
  document.getElementById('rateOut').textContent = Number(rate.value).toFixed(2);
  document.getElementById('pitchOut').textContent = Number(pitch.value).toFixed(2);
  document.getElementById('volumeOut').textContent = Math.round(volume.value * 100) + '%';
}

function persistTts() {
  const tts = {
    rate: Number(rate.value),
    pitch: Number(pitch.value),
    volume: Number(volume.value),
    speakAuthor: speakAuthor.checked,
    engine,
  };
  // Only persist the system-voice name while in system mode, so switching to
  // Azure and back doesn't clobber the saved system default.
  if (engine === 'system') tts.voice = voiceSelect.value;
  api.setConfig({ tts });
  if (engine === 'azure' && voiceSelect.value) {
    azureSavedVoice = voiceSelect.value;
    window.restream.azureSet({ voice: voiceSelect.value });
  }
}

// --- Engine switching + Azure voice list ---
async function setEngine(e, persist = true) {
  engine = e;
  engineSelect.value = e;
  reloadAzureVoicesBtn.hidden = (e !== 'azure');
  if (e === 'azure') {
    engineHint.textContent = 'Azure Neural — needs a saved key + region in Settings (Ctrl+6).';
    await populateAzureVoices();
  } else {
    engineHint.textContent = 'Built-in system voices — works offline.';
    loadVoices();
  }
  if (persist) persistTts();
}

async function populateAzureVoices() {
  voiceSelect.innerHTML = '<option>Loading Azure voices…</option>';
  try {
    if (!azureVoiceList.length) azureVoiceList = await window.restream.azureVoices();
    const enUS = azureVoiceList.filter(v => /^en-/i.test(v.Locale));
    enUS.sort((a, b) =>
      (/andrew/i.test(a.ShortName) ? 0 : 1) - (/andrew/i.test(b.ShortName) ? 0 : 1) ||
      a.ShortName.localeCompare(b.ShortName));
    voiceSelect.innerHTML = '';
    for (const v of enUS) {
      const opt = document.createElement('option');
      opt.value = v.ShortName;
      const star = /andrew/i.test(v.ShortName) ? ' ⭐' : '';
      opt.textContent = `${v.DisplayName} — ${v.Locale} ${v.Gender}${star}`;
      voiceSelect.appendChild(opt);
    }
    if (azureVoiceList.some(v => v.ShortName === azureSavedVoice)) voiceSelect.value = azureSavedVoice;
    announce(`${enUS.length} Azure voices loaded.`);
  } catch (err) {
    voiceSelect.innerHTML = '<option value="">Could not load Azure voices</option>';
    alertMsg('Azure voices failed: ' + (err.message || err));
  }
}
engineSelect.addEventListener('change', () => setEngine(engineSelect.value));
reloadAzureVoicesBtn.addEventListener('click', () => { azureVoiceList = []; populateAzureVoices(); });

[rate, pitch, volume].forEach(el => el.addEventListener('input', () => { updateOutputs(); }));
[voiceSelect, rate, pitch, volume, speakAuthor].forEach(el =>
  el.addEventListener('change', persistTts));

function speak(text) {
  if (!text) return;
  if (engine === 'azure') speakAzure(text);
  else speakSystem(text);
}
function speakMessage(author, text) {
  speak(speakAuthor.checked ? `${author} says: ${text}` : text);
}

// --- System (Web Speech) ---
function speakSystem(text) {
  const u = new SpeechSynthesisUtterance(text);
  const v = voices.find(v => v.name === voiceSelect.value);
  if (v) u.voice = v;
  u.rate = Number(rate.value);
  u.pitch = Number(pitch.value);
  u.volume = Number(volume.value);
  synth.speak(u);
}

// --- Azure Neural: synth in main, play sequentially so messages don't overlap ---
const azureQueue = [];
let azureCurrent = null;   // currently-playing HTMLAudioElement
let azureBusy = false;

// Slider (0.5–2 rate, 0–2 pitch) → SSML prosody strings ("+50%", "-25%").
function ssmlRate() { return `${Math.round((Number(rate.value) - 1) * 100)}%`; }
function ssmlPitch() { return `${Math.round((Number(pitch.value) - 1) * 50)}%`; }

async function speakAzure(text) {
  azureQueue.push(text);
  if (!azureBusy) drainAzureQueue();
}
async function drainAzureQueue() {
  azureBusy = true;
  while (azureQueue.length) {
    const text = azureQueue.shift();
    try {
      const b64 = await window.restream.azureSpeak({
        text, voice: voiceSelect.value || azureSavedVoice, rate: ssmlRate(), pitch: ssmlPitch(),
      });
      await playAzureClip(b64);
    } catch (err) {
      alertMsg('Azure TTS failed: ' + (err.message || err) + ' — falling back to system voice.');
      speakSystem(text); // graceful fallback
    }
  }
  azureBusy = false;
}
function playAzureClip(b64) {
  return new Promise((resolve) => {
    const audio = new Audio('data:audio/mp3;base64,' + b64);
    audio.volume = Number(volume.value);
    azureCurrent = audio;
    audio.onended = audio.onerror = () => { azureCurrent = null; resolve(); };
    audio.play().catch(() => { azureCurrent = null; resolve(); });
  });
}

function stopSpeaking() {
  if (synth.speaking || synth.pending) synth.cancel();
  azureQueue.length = 0;
  if (azureCurrent) { try { azureCurrent.pause(); } catch {} azureCurrent = null; }
  azureBusy = false;
}

document.getElementById('stopSpeaking').addEventListener('click', stopSpeaking);
document.getElementById('testVoice').addEventListener('click', () =>
  speak('This is a test of your selected voice for RestreamA11y chat reading.'));

// ---------------------------------------------------------------------------
// Utilities + init
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Load channels lazily the first time the Channels tab opens.
let channelsLoaded = false;
tabs[1].addEventListener('click', () => { if (!channelsLoaded) { channelsLoaded = true; loadChannels(); } });

// --- Azure settings (Settings tab) ---
const azureRegion = document.getElementById('azureRegion');
const azureKey = document.getElementById('azureKey');
document.getElementById('azureForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = document.getElementById('azureSaveState');
  st.className = 'save-state';
  st.textContent = 'Saving…';
  try {
    await window.restream.azureSet({ region: azureRegion.value, key: azureKey.value });
    azureKey.value = '';
    azureVoiceList = [];                 // force refetch with new creds
    st.className = 'save-state ok';
    st.textContent = 'Saved ✓';
    announce('Azure settings saved. Switch the engine to Azure Neural in the Voice tab.');
  } catch {
    st.className = 'save-state err';
    st.textContent = 'Could not save.';
  }
});

async function initAzure() {
  try {
    const a = await window.restream.azureGet();
    azureRegion.value = a.region || '';
    if (a.hasKey) azureKey.placeholder = '•••••• (saved — leave blank to keep)';
    azureSavedVoice = a.voice || azureSavedVoice;
  } catch {}
}

async function init() {
  await loadConfig();          // Restream config + applyTtsConfig (sets engine pref)
  await initAzure();
  await setEngine(engine, false); // populate the correct voice list without re-persisting
  updateOutputs();
}
init();
