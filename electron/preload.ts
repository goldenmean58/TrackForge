import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('trackforge', {
  chooseInput: () => ipcRenderer.invoke('file:choose-input'),
  chooseOutput: (inputPath: string) => ipcRenderer.invoke('file:choose-output', inputPath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  probeMedia: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
  startMux: (request: unknown) => ipcRenderer.invoke('mux:start', request),
  cancelMux: (jobId: string) => ipcRenderer.invoke('mux:cancel', jobId),
  showItem: (filePath: string) => ipcRenderer.invoke('shell:show-item', filePath),
  onProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('mux:progress', listener)
    return () => ipcRenderer.removeListener('mux:progress', listener)
  },
})
