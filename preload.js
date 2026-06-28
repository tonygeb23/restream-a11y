// Secure bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restream', {
  // Config + auth
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  connect: () => ipcRenderer.invoke('auth:connect'),
  disconnect: () => ipcRenderer.invoke('auth:disconnect'),
  getToken: () => ipcRenderer.invoke('auth:token'),

  // Generic REST proxy. method: 'GET'|'PATCH'|'PUT'|'POST', endpoint: '/user/...'
  api: (method, endpoint, body) =>
    ipcRenderer.invoke('api:call', { method, endpoint, body }),

  // Azure Neural TTS
  azureGet: () => ipcRenderer.invoke('azure:get'),
  azureSet: (partial) => ipcRenderer.invoke('azure:set', partial),
  azureVoices: () => ipcRenderer.invoke('azure:voices'),
  azureSpeak: (opts) => ipcRenderer.invoke('azure:speak', opts),
});
