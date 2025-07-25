const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src/main/preload.js')
    }
  });

  mainWindow.loadFile('src/renderer/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

async function getDiskUsage(dirPath) {
  try {
    // 現在のディレクトリの直下の要素を取得
    const result = await getDirectoryContents(dirPath);
    return result;
  } catch (error) {
    console.error('Error getting disk usage:', error);
    return [];
  }
}

async function getDirectoryContents(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    const baseName = path.basename(dirPath) || dirPath;
    
    if (!stats.isDirectory()) {
      return {
        name: baseName,
        path: dirPath,
        size: 0,
        type: 'directory',
        children: []
      };
    }
    
    const entries = await fs.readdir(dirPath);
    const children = [];
    
    for (const entry of entries) {
      // 隠しファイルをスキップ（オプション）
      if (entry.startsWith('.')) continue;
      
      const fullPath = path.join(dirPath, entry);
      try {
        const childStats = await fs.stat(fullPath);
        
        if (childStats.isFile()) {
          children.push({
            name: entry,
            path: fullPath,
            size: childStats.size,
            type: 'file'
          });
        } else if (childStats.isDirectory()) {
          // ディレクトリの場合は再帰的にサイズを計算
          const dirSize = await calculateDirectorySize(fullPath);
          children.push({
            name: entry,
            path: fullPath,
            size: dirSize,
            type: 'directory'
          });
        }
      } catch (err) {
        console.warn(`Skipping ${fullPath}: ${err.message}`);
      }
    }
    
    return {
      name: baseName,
      path: dirPath,
      size: children.reduce((sum, child) => sum + child.size, 0),
      type: 'directory',
      children: children
    };
  } catch (error) {
    console.warn(`Error accessing ${dirPath}: ${error.message}`);
    return {
      name: path.basename(dirPath) || dirPath,
      path: dirPath,
      size: 0,
      type: 'directory',
      children: []
    };
  }
}

async function calculateDirectorySize(dirPath) {
  try {
    const { stdout } = await execAsync(`du -s "${dirPath}"`);
    const size = parseInt(stdout.split('\t')[0]) * 1024; // KB to bytes
    return size;
  } catch (error) {
    console.warn(`Error calculating size for ${dirPath}: ${error.message}`);
    return 0;
  }
}

async function getDirectoryTree(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    const baseName = path.basename(dirPath) || dirPath;
    
    if (stats.isFile()) {
      return {
        name: baseName,
        path: dirPath,
        size: stats.size,
        type: 'file'
      };
    }
    
    if (stats.isDirectory()) {
      try {
        const entries = await fs.readdir(dirPath);
        const children = [];
        let totalSize = 0;
        
        for (const entry of entries) {
          // 隠しファイルをスキップ（オプション）
          if (entry.startsWith('.')) continue;
          
          const fullPath = path.join(dirPath, entry);
          try {
            const child = await getDirectoryTree(fullPath);
            if (child) {
              children.push(child);
              totalSize += child.size || 0;
            }
          } catch (err) {
            // アクセスできないファイル/ディレクトリはスキップ
            console.warn(`Skipping ${fullPath}: ${err.message}`);
          }
        }
        
        return {
          name: baseName,
          path: dirPath,
          size: totalSize,
          type: 'directory',
          children: children
        };
      } catch (err) {
        // ディレクトリが読めない場合
        return {
          name: baseName,
          path: dirPath,
          size: 0,
          type: 'directory',
          children: []
        };
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`Error accessing ${dirPath}: ${error.message}`);
    return null;
  }
}

async function getFileList(dirPath) {
  try {
    const { stdout } = await execAsync(`ls -la "${dirPath}"`);
    const lines = stdout.trim().split('\n').slice(1);
    
    const result = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      
      const permissions = parts[0];
      const links = parts[1];
      const owner = parts[2];
      const group = parts[3];
      const size = parts[4];
      const month = parts[5];
      const day = parts[6];
      const time = parts[7];
      const name = parts.slice(8).join(' ');
      
      if (name === '.' || name === '..') continue;
      
      result.push({
        permissions,
        links,
        owner,
        group,
        size,
        date: `${month} ${day} ${time}`,
        name
      });
    }
    
    return result;
  } catch (error) {
    console.error('Error getting file list:', error);
    return [];
  }
}

ipcMain.handle('get-disk-usage', async (event, dirPath) => {
  return await getDiskUsage(dirPath);
});

ipcMain.handle('get-file-list', async (event, dirPath) => {
  return await getFileList(dirPath);
});

ipcMain.handle('get-home-directory', () => {
  return require('os').homedir();
});

ipcMain.handle('get-current-directory', () => {
  return process.cwd();
});

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    console.error('Error opening file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-in-finder', async (event, filePath) => {
  try {
    console.log('Attempting to show in finder:', filePath);
    console.log('Platform:', process.platform);
    
    // ファイル/ディレクトリの存在確認
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      console.error('File/directory does not exist:', filePath);
      return { success: false, error: 'ファイルまたはディレクトリが存在しません' };
    }
    
    // プラットフォーム別の処理
    if (process.platform === 'darwin') {
      // macOS: Finderで表示
      shell.showItemInFolder(filePath);
    } else if (process.platform === 'win32') {
      // Windows: エクスプローラーで表示
      shell.showItemInFolder(filePath);
    } else {
      // Linux: 親ディレクトリを開く
      const parentDir = path.dirname(filePath);
      await shell.openPath(parentDir);
    }
    
    console.log('Successfully showed in file manager:', filePath);
    return { success: true };
  } catch (error) {
    console.error('Error showing in file manager:', error);
    
    // 代替手段：親ディレクトリを開く
    try {
      const parentDir = path.dirname(filePath);
      console.log('Fallback: opening parent directory:', parentDir);
      await shell.openPath(parentDir);
      return { success: true, fallback: true };
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      return { success: false, error: `${error.message} (代替手段も失敗: ${fallbackError.message})` };
    }
  }
});

ipcMain.handle('select-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'フォルダを選択してください',
      defaultPath: process.cwd()
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      console.log('Selected folder:', selectedPath);
      return { success: true, path: selectedPath };
    } else {
      return { success: false, canceled: true };
    }
  } catch (error) {
    console.error('Error selecting folder:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    console.log('Attempting to delete file/directory:', filePath);
    
    // セキュリティチェック：重要なシステムディレクトリは削除を防ぐ
    const dangerousPaths = ['/', '/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/tmp'];
    const normalizedPath = path.resolve(filePath);
    
    if (dangerousPaths.some(dangerous => normalizedPath === dangerous || normalizedPath.startsWith(dangerous + '/'))) {
      console.error('Attempted to delete dangerous system path:', normalizedPath);
      return { success: false, error: 'システムの重要なディレクトリは削除できません' };
    }
    
    // ファイル/ディレクトリの存在確認
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      console.error('File/directory does not exist:', filePath);
      return { success: false, error: 'ファイルまたはディレクトリが存在しません' };
    }
    
    // ファイルかディレクトリかを判定
    const stats = await fs.stat(filePath);
    
    if (stats.isDirectory()) {
      // ディレクトリの場合：再帰的に削除
      await fs.rmdir(filePath, { recursive: true });
      console.log('Successfully deleted directory:', filePath);
    } else {
      // ファイルの場合：削除
      await fs.unlink(filePath);
      console.log('Successfully deleted file:', filePath);
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error deleting file/directory:', error);
    
    // エラーの種類に応じたメッセージ
    let errorMessage = error.message;
    if (error.code === 'ENOENT') {
      errorMessage = 'ファイルまたはディレクトリが見つかりません';
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      errorMessage = '削除する権限がありません';
    } else if (error.code === 'ENOTEMPTY') {
      errorMessage = 'ディレクトリが空ではありません';
    } else if (error.code === 'EBUSY') {
      errorMessage = 'ファイルまたはディレクトリが使用中です';
    }
    
    return { success: false, error: errorMessage };
  }
});