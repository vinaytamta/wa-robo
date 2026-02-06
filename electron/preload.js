const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Mark this as Electron environment
  isElectron: true,

  // WhatsApp controls
  startWhatsApp: (userData) => ipcRenderer.invoke('start-whatsapp', userData),
  stopWhatsApp: () => ipcRenderer.invoke('stop-whatsapp'),
  getWhatsAppStatus: () => ipcRenderer.invoke('get-whatsapp-status'),

  // Notifications
  showNotification: (data) => ipcRenderer.invoke('show-notification', data),

  // Listen to WhatsApp events
  onWhatsAppLog: (callback) => {
    ipcRenderer.on('whatsapp-log', (event, data) => callback(data));
  },
  onWhatsAppError: (callback) => {
    ipcRenderer.on('whatsapp-error', (event, data) => callback(data));
  },
  onWhatsAppStopped: (callback) => {
    ipcRenderer.on('whatsapp-stopped', (event, code) => callback(code));
  },

  // Remove listeners
  removeWhatsAppListeners: () => {
    ipcRenderer.removeAllListeners('whatsapp-log');
    ipcRenderer.removeAllListeners('whatsapp-error');
    ipcRenderer.removeAllListeners('whatsapp-stopped');
  }
});
