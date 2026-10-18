'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const PORT = 38471;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'production';
let mainWindow;

app.whenReady().then(() => {
  // The bundled local server keeps WebSocket multiplayer and the browser client on one origin.
  require(path.join(__dirname, '..', 'server.js'));
  setTimeout(() => {
    mainWindow = new BrowserWindow({
      width: 1440, height: 900, minWidth: 860, minHeight: 600,
      fullscreen: true, autoHideMenuBar: true, backgroundColor: '#10131b',
      title: 'Gith World RP',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(`http://127.0.0.1:${PORT}`)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }, 700);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.relaunch(); });
