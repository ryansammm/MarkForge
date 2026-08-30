'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('markforge', {
  desktop: true,
  selectDirectory: () => ipcRenderer.invoke('markforge:select-directory'),
  syncToCloud: () => ipcRenderer.invoke('markforge:sync-to-cloud'),
  openInWindow: (path) => ipcRenderer.invoke('markforge:open-window', path),
})
