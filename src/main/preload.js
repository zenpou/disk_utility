const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getDiskUsage: (dirPath) => ipcRenderer.invoke('get-disk-usage', dirPath),
  getFileList: (dirPath) => ipcRenderer.invoke('get-file-list', dirPath),
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  getCurrentDirectory: () => ipcRenderer.invoke('get-current-directory'),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  clearDuCache: () => ipcRenderer.invoke('clear-du-cache'),
  invalidateDuCache: (targetPath) => ipcRenderer.invoke('invalidate-du-cache', targetPath),
  
  // 進捗監視
  onDuProgress: (callback) => {
    ipcRenderer.on('du-progress', (event, progress) => callback(progress));
  },
  removeDuProgressListener: () => {
    ipcRenderer.removeAllListeners('du-progress');
  }
});