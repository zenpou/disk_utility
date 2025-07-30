const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// バックエンドキャッシュ
const duCache = new Map(); // duコマンドの結果全体をキャッシュ
const CACHE_EXPIRY = 3600000; // 1時間（フロントエンドと同じ）

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

async function getDiskUsage(dirPath, event = null) {
  try {
    // 現在のディレクトリの直下の要素を取得
    const result = await getDirectoryContents(dirPath, event);
    return result;
  } catch (error) {
    console.error('Error getting disk usage:', error);
    return [];
  }
}

async function getDirectoryContents(dirPath, event = null) {
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
    
    // キャッシュされた範囲を探すか、新しいルートとしてdirPathを使用
    let duRootPath = findCachedRoot(dirPath);
    if (!duRootPath) {
      duRootPath = dirPath;
      console.log(`No cached root found for ${dirPath}, using as new root`);
    } else {
      console.log(`Using cached root ${duRootPath} for ${dirPath}`);
    }
    
    // 進捗コールバック関数
    const onProgress = event ? (progress) => {
      event.sender.send('du-progress', {
        processedFiles: progress.processedFiles,
        currentPath: progress.currentPath,
        isComplete: progress.isComplete
      });
    } : null;
    
    // 全サイズ情報を一括取得（この時点でキャッシュされる）
    const sizeMap = await getAllDirectorySizes(duRootPath, onProgress);
    
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
          // duキャッシュからサイズを取得（高速）
          const dirSize = sizeMap.get(fullPath) || 0;
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

// duキャッシュの有効性チェック
function isDuCacheValid(rootPath) {
  if (!duCache.has(rootPath)) {
    return false;
  }
  
  const cached = duCache.get(rootPath);
  const now = Date.now();
  const isValid = (now - cached.timestamp) < CACHE_EXPIRY;
  
  if (!isValid) {
    console.log('DU cache expired for:', rootPath);
    duCache.delete(rootPath);
  }
  
  return isValid;
}

// キャッシュをクリア
function clearDuCache() {
  console.log('Clearing all DU cache');
  duCache.clear();
}

// 特定のパスに関連するキャッシュを無効化
function invalidateDuCache(targetPath) {
  const normalizedTarget = normalizePath(targetPath);
  const toDelete = [];
  
  for (const [cachedRoot] of duCache) {
    const normalizedRoot = normalizePath(cachedRoot);
    
    // targetPathがcachedRootの子、親、または同じの場合は無効化
    if (normalizedTarget === normalizedRoot || 
        normalizedTarget.startsWith(normalizedRoot + path.sep) ||
        normalizedRoot.startsWith(normalizedTarget + path.sep)) {
      toDelete.push(cachedRoot);
    }
  }
  
  toDelete.forEach(root => {
    console.log('Invalidating DU cache for:', root);
    duCache.delete(root);
  });
}

// 進捗付きでduコマンドを実行（ストリーミング処理）
function executeDuWithProgress(rootPath, includeFiles = true, onProgress = null) {
  return new Promise((resolve, reject) => {
    const duArgs = includeFiles ? ['-ak', rootPath] : ['-k', rootPath];
    const duProcess = spawn('du', duArgs);
    
    const sizeMap = new Map();
    let buffer = '';
    let lineCount = 0;
    let lastProgressTime = Date.now();
    let currentPath = rootPath;
    
    duProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      
      // 行ごとに処理（メモリ効率向上）
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        
        if (line.trim()) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const sizeKB = parseInt(parts[0]);
            const filePath = parts[1];
            const sizeBytes = sizeKB * 1024;
            sizeMap.set(filePath, sizeBytes);
            currentPath = filePath;
            lineCount++;
          }
        }
      }
      
      // 進捗更新（1秒に1回程度）
      const now = Date.now();
      if (onProgress && (now - lastProgressTime) > 1000) {
        onProgress({
          processedFiles: lineCount,
          currentPath: currentPath,
          isComplete: false
        });
        
        lastProgressTime = now;
      }
    });
    
    duProcess.stderr.on('data', (data) => {
      console.warn('du stderr:', data.toString());
    });
    
    duProcess.on('close', (code) => {
      // 残りのバッファを処理
      if (buffer.trim()) {
        const parts = buffer.trim().split('\t');
        if (parts.length >= 2) {
          const sizeKB = parseInt(parts[0]);
          const filePath = parts[1];
          const sizeBytes = sizeKB * 1024;
          sizeMap.set(filePath, sizeBytes);
          lineCount++;
        }
      }
      
      if (code === 0) {
        // 完了時の進捗更新
        if (onProgress) {
          onProgress({
            processedFiles: lineCount,
            currentPath: rootPath,
            isComplete: true
          });
        }
        console.log(`DU completed: processed ${lineCount} entries, map size: ${sizeMap.size}`);
        resolve(sizeMap);
      } else {
        reject(new Error(`du command failed with code ${code}`));
      }
    });
    
    duProcess.on('error', (error) => {
      reject(error);
    });
    
    // タイムアウト処理
    const timeout = setTimeout(() => {
      duProcess.kill();
      reject(new Error('du command timed out after 10 minutes'));
    }, 600000); // 10分
    
    duProcess.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// 指定されたルートディレクトリ以下の全サイズ情報を一括取得
async function getAllDirectorySizes(rootPath, onProgress = null) {
  try {
    // キャッシュチェック
    if (isDuCacheValid(rootPath)) {
      console.log('Using cached DU data for:', rootPath);
      return duCache.get(rootPath).sizeMap;
    }

    console.log('Fetching fresh DU data for:', rootPath);
    
    // 進捗コールバック付きでdu実行（直接Mapを返す）
    const sizeMap = await executeDuWithProgress(rootPath, true, onProgress);
    
    // キャッシュに保存
    duCache.set(rootPath, {
      sizeMap: sizeMap,
      timestamp: Date.now()
    });
    
    console.log(`Cached ${sizeMap.size} entries for ${rootPath}`);
    return sizeMap;
    
  } catch (error) {
    console.warn(`Error getting DU data for ${rootPath}: ${error.message}`);
    
    // フォールバック処理
    if (error.message.includes('maxBuffer') || error.message.includes('stdout maxBuffer') || error.message.includes('timed out') || error.message.includes('Invalid string length')) {
      console.log('Trying fallback: du without -a option (directories only)');
      try {
        // フォールバックでも直接Mapを返すストリーミング処理を使用
        const sizeMap = await executeDuWithProgress(rootPath, false, onProgress);
        
        // フォールバックキャッシュに保存
        duCache.set(rootPath, {
          sizeMap: sizeMap,
          timestamp: Date.now()
        });
        
        console.log(`Fallback: Cached ${sizeMap.size} directory entries for ${rootPath}`);
        return sizeMap;
        
      } catch (fallbackError) {
        console.warn(`Fallback also failed for ${rootPath}: ${fallbackError.message}`);
      }
    }
    
    return new Map();
  }
}

// パスを正規化（末尾のスラッシュを削除、相対パスを絶対パスに変換）
function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return resolved.replace(/\/+$/, '') || '/';
}

// 指定されたパスがどのキャッシュルートに含まれるかを検索
function findCachedRoot(targetPath) {
  const normalizedTarget = normalizePath(targetPath);
  
  let bestMatch = null;
  let bestMatchLength = 0;
  
  for (const [cachedRoot, cacheData] of duCache) {
    // キャッシュが有効かチェック
    const now = Date.now();
    if ((now - cacheData.timestamp) >= CACHE_EXPIRY) {
      continue;
    }
    
    const normalizedRoot = normalizePath(cachedRoot);
    
    // targetPathがcachedRootの子または同じパスかチェック
    if (normalizedTarget === normalizedRoot || 
        normalizedTarget.startsWith(normalizedRoot + path.sep)) {
      // より深い（具体的な）マッチを優先
      if (normalizedRoot.length > bestMatchLength) {
        bestMatch = cachedRoot;
        bestMatchLength = normalizedRoot.length;
      }
    }
  }
  
  return bestMatch;
}

// 特定のディレクトリサイズを効率的に取得
async function calculateDirectorySize(dirPath, rootPath = null) {
  try {
    let duRootPath = rootPath;
    
    // ルートパスが指定されていない場合は、キャッシュから探す
    if (!duRootPath) {
      duRootPath = findCachedRoot(dirPath);
      if (!duRootPath) {
        // キャッシュにない場合は、dirPathをルートとして使用
        duRootPath = dirPath;
      }
    }
    
    // 全サイズ情報を取得（キャッシュから、または新規取得）
    const sizeMap = await getAllDirectorySizes(duRootPath);
    
    // 指定されたディレクトリのサイズを取得
    if (sizeMap.has(dirPath)) {
      return sizeMap.get(dirPath);
    }
    
    // 見つからない場合は0を返す
    console.warn(`Size not found for ${dirPath} in DU data`);
    return 0;
    
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
  return await getDiskUsage(dirPath, event);
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

// キャッシュクリア用のIPCハンドラー
ipcMain.handle('clear-du-cache', () => {
  clearDuCache();
  return { success: true };
});

// 特定パスのキャッシュ無効化用のIPCハンドラー
ipcMain.handle('invalidate-du-cache', (event, targetPath) => {
  invalidateDuCache(targetPath);
  return { success: true };
});