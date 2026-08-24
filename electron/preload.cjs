'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('markforge', {
  desktop: true,
  chooseFiles: () => ipcRenderer.invoke('markforge:choose-files'),
  chooseFolder: () => ipcRenderer.invoke('markforge:choose-folder'),
})
