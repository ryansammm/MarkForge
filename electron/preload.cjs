'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('markforge', {
  desktop: true,
  selectDirectory: () => ipcRenderer.invoke('markforge:select-directory'),
  syncToCloud: () => ipcRenderer.invoke('markforge:sync-to-cloud'),
  openInWindow: (path) => ipcRenderer.invoke('markforge:open-window', path),
  /**
   * Save a text file via the OS "Save As…" dialog. Returns the
   * path the user picked, or `null` if they cancelled. Throws
   * (propagated back through `ipcRenderer.invoke`'s promise) if
   * the write itself fails.
   */
  saveFile: (payload) => ipcRenderer.invoke('markforge:save-file', payload),
})
