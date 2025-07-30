class DiskUtilityApp {
    constructor() {
        this.currentPath = '/';
        this.data = [];
        this.contextMenuTarget = null;
        this.cache = new Map(); // ディレクトリデータのキャッシュ
        this.cacheExpiry = 3600000; // キャッシュの有効期限（1時間 = 60分 × 60秒 × 1000ms）
        this.progressStartTime = null; // 進捗開始時刻
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.setupProgressListener();
        this.showFolderSelection();
    }
    
    setupProgressListener() {
        // DU進捗リスナーを設定
        window.electronAPI.onDuProgress((progress) => {
            this.updateProgressDisplay(progress);
        });
    }
    
    updateProgressDisplay(progress) {
        const { processedFiles, currentPath, isComplete } = progress;
        
        if (isComplete) {
            // 完了時は通常のローディング表示に戻す
            this.progressStartTime = null;
            return;
        }
        
        // 進捗率を推定（複数の要因を組み合わせ）
        let estimatedProgress = 0;
        
        // 1. ファイル数ベースの進捗（対数スケール）
        const fileBasedProgress = Math.min(70, Math.log10(Math.max(1, processedFiles)) * 15);
        
        // 2. 時間ベースの進捗
        let timeBasedProgress = 0;
        if (this.progressStartTime) {
            const elapsed = (Date.now() - this.progressStartTime) / 1000; // 秒
            // 最初の30秒で50%、その後は緩やかに上昇
            if (elapsed <= 30) {
                timeBasedProgress = (elapsed / 30) * 50;
            } else {
                timeBasedProgress = 50 + Math.min(40, (elapsed - 30) / 60 * 40);
            }
        }
        
        // 3. 両方の要因を組み合わせ（より高い値を採用、但し95%でキャップ）
        estimatedProgress = Math.min(95, Math.max(fileBasedProgress, timeBasedProgress));
        
        // 経過時間の表示
        const elapsed = this.progressStartTime ? Math.floor((Date.now() - this.progressStartTime) / 1000) : 0;
        const elapsedDisplay = elapsed > 0 ? `${elapsed}秒経過` : '';
        
        // 進捗表示を更新
        const progressHTML = `
            <div class="loading">
                <div>読み込み中... ${elapsedDisplay}</div>
                <div class="progress-info">
                    <div>処理済み: ${processedFiles.toLocaleString()} ファイル</div>
                    <div class="current-path">現在: ${this.truncatePath(currentPath)}</div>
                </div>
                <div class="progress-bar">
                    <div class="progress-bar-fill" style="width: ${estimatedProgress}%"></div>
                </div>
                <div class="progress-percentage">${Math.round(estimatedProgress)}%</div>
            </div>
        `;
        
        document.getElementById('treemap').innerHTML = progressHTML;
        document.getElementById('fileList').innerHTML = progressHTML;
    }
    
    truncatePath(fullPath, maxLength = 60) {
        if (fullPath.length <= maxLength) {
            return fullPath;
        }
        
        // パスを省略形で表示
        const parts = fullPath.split('/');
        if (parts.length <= 2) {
            return fullPath;
        }
        
        // 最初と最後の部分を保持
        const start = parts.slice(0, 2).join('/');
        const end = parts.slice(-2).join('/');
        return `${start}/.../${end}`;
    }

    setupEventListeners() {
        document.getElementById('upBtn').addEventListener('click', () => {
            this.goUpDirectory();
        });

        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.refreshCurrentDirectory();
        });

        document.getElementById('homeBtn').addEventListener('click', async () => {
            const homeDir = await window.electronAPI.getHomeDirectory();
            this.loadDirectory(homeDir);
        });

        document.getElementById('rootBtn').addEventListener('click', () => {
            this.loadDirectory('/');
        });

        // フォルダ選択ボタン（ヘッダー）
        document.getElementById('selectFolderHeaderBtn').addEventListener('click', () => {
            this.showFolderSelectionDialog();
        });

        // フォルダ選択オーバーレイのボタン
        document.getElementById('selectFolderBtn').addEventListener('click', () => {
            this.showFolderSelectionDialog();
        });

        document.getElementById('useHomeDirBtn').addEventListener('click', async () => {
            const homeDir = await window.electronAPI.getHomeDirectory();
            this.hideFolderSelection();
            this.loadDirectory(homeDir);
        });

        // コンテキストメニューのイベントリスナー
        this.setupContextMenu();
        
        // ドキュメント全体のクリックでメニューを隠す
        document.addEventListener('click', () => {
            this.hideContextMenu();
        });

        // キーボードショートカット
        document.addEventListener('keydown', (e) => {
            // F5またはCmd+Rで再読み込み
            if (e.key === 'F5' || (e.metaKey && e.key === 'r')) {
                e.preventDefault();
                this.refreshCurrentDirectory();
            }
        });
    }

    async loadDirectory(path, forceReload = false) {
        this.currentPath = path;
        document.getElementById('currentPath').textContent = path;
        
        // キャッシュチェック
        if (!forceReload && this.isCacheValid(path)) {
            console.log('Using cached data for:', path);
            const cachedData = this.cache.get(path).data;
            this.data = cachedData;
            this.renderTreemap(cachedData);
            this.renderFileList(cachedData.children || []);
            this.updateButtonStates(false);
            return;
        }
        
        // ボタンの状態を更新
        this.updateButtonStates(true); // ローディング中
        
        // 進捗開始時刻を記録
        this.progressStartTime = Date.now();
        
        document.getElementById('treemap').innerHTML = '<div class="loading">読み込み中...<br><small>大きなディレクトリの場合、数分かかることがあります</small></div>';
        document.getElementById('fileList').innerHTML = '<div class="loading">読み込み中...<br><small>大きなディレクトリの場合、数分かかることがあります</small></div>';

        try {
            console.log('Fetching fresh data for:', path);
            const diskData = await window.electronAPI.getDiskUsage(path);

            // データをキャッシュに保存
            this.cache.set(path, {
                data: diskData,
                timestamp: Date.now()
            });

            this.data = diskData;
            this.renderTreemap(diskData);
            this.renderFileList(diskData.children || []);
        } catch (error) {
            console.error('Error loading directory:', error);
            document.getElementById('treemap').innerHTML = '<div class="loading">エラーが発生しました</div>';
            document.getElementById('fileList').innerHTML = '<div class="loading">エラーが発生しました</div>';
        } finally {
            // ローディング完了後にボタンの状態を復元
            this.updateButtonStates(false);
        }
    }

    // キャッシュの有効性をチェック
    isCacheValid(path) {
        if (!this.cache.has(path)) {
            return false;
        }
        
        const cached = this.cache.get(path);
        const now = Date.now();
        const isValid = (now - cached.timestamp) < this.cacheExpiry;
        
        if (!isValid) {
            console.log('Cache expired for:', path);
            this.cache.delete(path);
        }
        
        return isValid;
    }

    // キャッシュをクリア
    clearCache() {
        console.log('Clearing all cache');
        this.cache.clear();
    }

    // 特定のパスのキャッシュを削除
    invalidateCache(path) {
        console.log('Invalidating cache for:', path);
        this.cache.delete(path);
        // 親ディレクトリのキャッシュも削除（ファイル削除などの場合）
        const parentPath = this.getParentPath(path);
        if (parentPath !== path) {
            this.cache.delete(parentPath);
        }
    }

    renderTreemap(data) {
        const container = document.getElementById('treemap');
        container.innerHTML = '';

        if (!data || !data.children || data.children.length === 0) {
            container.innerHTML = '<div class="loading">データがありません</div>';
            return;
        }

        const width = container.clientWidth;
        const height = container.clientHeight || 400;

        const svg = d3.select('#treemap')
            .append('svg')
            .attr('width', width)
            .attr('height', height);

        // 現在のディレクトリの直下の要素のみを表示するため、data.childrenを使用
        const flatData = data.children.map(child => ({
            name: child.name,
            path: child.path,
            size: child.size,
            type: child.type
        }));

        // D3階層構造を作成
        const root = d3.hierarchy({children: flatData})
            .sum(d => d.size)
            .sort((a, b) => b.value - a.value);

        const treemap = d3.treemap()
            .size([width, height])
            .padding(2)
            .round(true);

        treemap(root);

        // カラースケール
        const colorScale = d3.scaleOrdinal()
            .domain(['file', 'directory'])
            .range(['#3498db', '#e74c3c']);

        // 葉ノードのみを取得
        const leaves = root.leaves();

        const cell = svg.selectAll('g')
            .data(leaves)
            .enter().append('g')
            .attr('transform', d => `translate(${d.x0},${d.y0})`);

        // 矩形を描画
        cell.append('rect')
            .attr('width', d => Math.max(0, d.x1 - d.x0))
            .attr('height', d => Math.max(0, d.y1 - d.y0))
            .attr('fill', d => colorScale(d.data.type))
            .attr('stroke', '#fff')
            .attr('stroke-width', 1)
            .style('cursor', d => d.data.type === 'directory' ? 'pointer' : 'default')
            .on('click', (event, d) => {
                if (d.data.type === 'directory') {
                    this.loadDirectory(d.data.path);
                }
            })
            .on('contextmenu', (event, d) => {
                event.preventDefault();
                this.showContextMenu(event, d.data);
            })
            .append('title')
            .text(d => `${d.data.name}\n${this.formatBytes(d.data.size)}\n${d.data.path}`);

        // ラベルを追加
        cell.append('text')
            .attr('class', 'rect-label')
            .attr('x', 4)
            .attr('y', 14)
            .attr('font-size', d => {
                const width = d.x1 - d.x0;
                return Math.min(12, width / 8) + 'px';
            })
            .text(d => {
                const width = d.x1 - d.x0;
                const height = d.y1 - d.y0;
                const name = d.data.name;
                
                if (width < 30 || height < 20) return '';
                
                const maxChars = Math.floor(width / 6);
                if (name.length > maxChars) {
                    return name.substring(0, maxChars - 3) + '...';
                }
                return name;
            })
            .style('fill', '#fff')
            .style('font-weight', 'bold')
            .style('text-shadow', '1px 1px 1px rgba(0,0,0,0.7)');

        // サイズラベルを追加
        cell.append('text')
            .attr('class', 'rect-size-label')
            .attr('x', 4)
            .attr('y', 28)
            .attr('font-size', '10px')
            .text(d => {
                const width = d.x1 - d.x0;
                const height = d.y1 - d.y0;
                if (width < 60 || height < 40) return '';
                return this.formatBytes(d.data.size);
            })
            .style('fill', '#fff')
            .style('text-shadow', '1px 1px 1px rgba(0,0,0,0.7)');
    }

    renderFileList(files) {
        const container = document.getElementById('fileList');
        
        if (!files || files.length === 0) {
            container.innerHTML = '<p>ファイルがありません</p>';
            return;
        }

        // サイズ順でソート（大きい順）
        const sortedFiles = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));

        const table = document.createElement('table');
        table.className = 'file-table';

        const header = table.createTHead();
        const headerRow = header.insertRow();
        ['ファイル名', 'サイズ', 'タイプ'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });

        const tbody = table.createTBody();
        
        // 親ディレクトリ（..）を追加（ルートディレクトリ以外）
        if (this.currentPath !== '/') {
            this.addDirectoryNavigationRow(tbody, '..', null, 'parent-directory');
        }
        
        // 現在のディレクトリ（.）を追加
        this.addDirectoryNavigationRow(tbody, '.', this.data.size, 'current-directory');
        sortedFiles.forEach(file => {
            const row = tbody.insertRow();
            
            // ファイル名セル
            const nameCell = row.insertCell();
            nameCell.textContent = file.name;
            nameCell.className = file.type === 'directory' ? 'directory-name' : 'file-name';
            if (file.type === 'directory') {
                nameCell.style.cursor = 'pointer';
                nameCell.addEventListener('click', () => {
                    this.loadDirectory(file.path);
                });
            }
            
            // 右クリックイベントを追加
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showContextMenu(e, file);
            });
            
            // サイズセル
            const sizeCell = row.insertCell();
            sizeCell.textContent = this.formatBytes(file.size || 0);
            sizeCell.className = 'size-cell';
            
            // タイプセル
            const typeCell = row.insertCell();
            typeCell.textContent = file.type === 'directory' ? 'フォルダ' : 'ファイル';
            typeCell.className = file.type === 'directory' ? 'type-directory' : 'type-file';
        });

        container.innerHTML = '';
        container.appendChild(table);
    }

    addDirectoryNavigationRow(tbody, name, size, className) {
        const row = tbody.insertRow();
        row.className = className;
        
        // ファイル名セル
        const nameCell = row.insertCell();
        nameCell.textContent = name;
        nameCell.className = 'navigation-directory';
        nameCell.style.cursor = 'pointer';
        
        // クリックイベント
        nameCell.addEventListener('click', () => {
            if (name === '.') {
                // 現在のディレクトリを再読み込み
                this.refreshCurrentDirectory();
            } else if (name === '..') {
                // 親ディレクトリに移動
                this.goUpDirectory();
            }
        });
        
        // 右クリックイベント（コンテキストメニュー用）
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const targetPath = name === '..' ? this.getParentPath() : this.currentPath;
            const fileData = {
                name: name,
                path: targetPath,
                size: size || 0,
                type: 'directory'
            };
            this.showContextMenu(e, fileData);
        });
        
        // サイズセル
        const sizeCell = row.insertCell();
        if (size !== null) {
            sizeCell.textContent = this.formatBytes(size);
        } else {
            sizeCell.textContent = '-';
        }
        sizeCell.className = 'size-cell';
        
        // タイプセル
        const typeCell = row.insertCell();
        if (name === '.') {
            typeCell.textContent = '現在のフォルダ';
        } else if (name === '..') {
            typeCell.textContent = '親フォルダ';
        }
        typeCell.className = 'type-navigation';
    }

    getParentPath() {
        if (this.currentPath === '/') {
            return '/';
        }
        const normalizedPath = this.currentPath.replace(/\/+$/, '');
        return normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) || '/';
    }

    updateButtonStates(isLoading = false) {
        const upBtn = document.getElementById('upBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const homeBtn = document.getElementById('homeBtn');
        const rootBtn = document.getElementById('rootBtn');

        if (isLoading) {
            // ローディング中はすべてのボタンを無効化
            upBtn.disabled = true;
            refreshBtn.disabled = true;
            refreshBtn.textContent = '読み込み中...';
            homeBtn.disabled = true;
            rootBtn.disabled = true;
        } else {
            // ローディング完了後は適切な状態に復元
            refreshBtn.disabled = false;
            refreshBtn.textContent = '再読み込み';
            homeBtn.disabled = false;
            rootBtn.disabled = false;
            
            // 上のディレクトリボタンの状態を更新
            if (this.currentPath === '/') {
                upBtn.disabled = true;
                upBtn.textContent = '上のディレクトリ (ルート)';
            } else {
                upBtn.disabled = false;
                upBtn.textContent = '上のディレクトリ';
            }
        }
    }

    // 後方互換性のため残しておく
    updateUpButtonState() {
        this.updateButtonStates(false);
    }

    async refreshCurrentDirectory() {
        if (this.currentPath) {
            console.log('Refreshing current directory:', this.currentPath);
            
            // フロントエンドキャッシュをクリア
            this.clearCache();
            
            // バックエンドキャッシュもクリア
            try {
                await window.electronAPI.clearDuCache();
                console.log('Backend DU cache cleared');
            } catch (error) {
                console.warn('Failed to clear backend cache:', error);
            }
            
            // 強制リロード（キャッシュを無視）
            this.loadDirectory(this.currentPath, true);
        }
    }

    goUpDirectory() {
        if (this.currentPath === '/') {
            // ルートディレクトリの場合は移動しない
            return;
        }
        
        // パスを正規化してから親ディレクトリを取得
        const normalizedPath = this.currentPath.replace(/\/+$/, ''); // 末尾のスラッシュを削除
        const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) || '/';
        
        this.loadDirectory(parentPath);
    }

    setupContextMenu() {
        // コンテキストメニューアイテムのイベントリスナー
        document.getElementById('openItem').addEventListener('click', () => {
            this.handleOpenItem();
        });
        
        document.getElementById('showInFinderItem').addEventListener('click', () => {
            this.handleShowInFinder();
        });
        
        document.getElementById('copyPathItem').addEventListener('click', () => {
            this.handleCopyPath();
        });
        
        document.getElementById('copyNameItem').addEventListener('click', () => {
            this.handleCopyName();
        });
        
        document.getElementById('propertiesItem').addEventListener('click', () => {
            this.handleProperties();
        });
        
        document.getElementById('deleteItem').addEventListener('click', () => {
            this.handleDelete();
        });
    }

    showContextMenu(event, file) {
        this.contextMenuTarget = file;
        const contextMenu = document.getElementById('contextMenu');
        
        // メニューの位置を設定
        contextMenu.style.left = event.pageX + 'px';
        contextMenu.style.top = event.pageY + 'px';
        contextMenu.style.display = 'block';
        
        // メニューアイテムの有効/無効を設定
        const openItem = document.getElementById('openItem');
        const deleteItem = document.getElementById('deleteItem');
        
        if (file.type === 'directory') {
            openItem.textContent = 'フォルダを開く';
            openItem.classList.remove('disabled');
        } else {
            openItem.textContent = 'ファイルを開く';
            openItem.classList.remove('disabled');
        }
        
        // 削除メニューの制御（.と..は削除不可）
        if (file.name === '.' || file.name === '..') {
            deleteItem.classList.add('disabled');
            deleteItem.textContent = '削除（不可）';
        } else {
            deleteItem.classList.remove('disabled');
            deleteItem.textContent = '削除';
        }
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        contextMenu.style.display = 'none';
        this.contextMenuTarget = null;
    }

    handleOpenItem() {
        if (!this.contextMenuTarget) return;
        
        const target = this.contextMenuTarget;
        this.hideContextMenu();
        
        if (target.type === 'directory') {
            this.loadDirectory(target.path);
        } else {
            // ファイルを開く（外部アプリケーション）
            this.openFile(target.path);
        }
    }

    handleShowInFinder() {
        if (!this.contextMenuTarget) return;
        const target = this.contextMenuTarget;
        this.hideContextMenu();
        this.showInFinder(target.path);
    }

    handleCopyPath() {
        if (!this.contextMenuTarget) return;
        const target = this.contextMenuTarget;
        this.hideContextMenu();
        navigator.clipboard.writeText(target.path);
    }

    handleCopyName() {
        if (!this.contextMenuTarget) return;
        const target = this.contextMenuTarget;
        this.hideContextMenu();
        navigator.clipboard.writeText(target.name);
    }

    handleProperties() {
        if (!this.contextMenuTarget) return;
        const target = this.contextMenuTarget;
        this.hideContextMenu();
        alert(`名前: ${target.name}\nパス: ${target.path}\nサイズ: ${this.formatBytes(target.size)}\nタイプ: ${target.type === 'directory' ? 'フォルダ' : 'ファイル'}`);
    }

    handleDelete() {
        console.log('handleDelete called, contextMenuTarget:', this.contextMenuTarget);
        
        if (!this.contextMenuTarget) {
            console.error('No context menu target available for deletion');
            return;
        }
        
        // .と..は削除不可
        if (this.contextMenuTarget.name === '.' || this.contextMenuTarget.name === '..') {
            console.log('Cannot delete navigation directories');
            this.hideContextMenu();
            return;
        }
        
        // contextMenuTargetを保存してからメニューを隠す
        const targetToDelete = { ...this.contextMenuTarget }; // ディープコピーで安全性向上
        console.log('Target to delete:', targetToDelete);
        this.hideContextMenu();
        this.showDeleteConfirmationDialog(targetToDelete);
    }

    showDeleteConfirmationDialog(fileData) {
        // 安全性チェック
        if (!fileData || !fileData.name || !fileData.path) {
            console.error('Invalid file data for deletion:', fileData);
            alert('削除対象のファイル情報が不正です');
            return;
        }
        
        const fileName = fileData.name;
        const fileType = fileData.type === 'directory' ? 'フォルダ' : 'ファイル';
        const filePath = fileData.path;
        
        const message = `本当に削除しますか？\n\n${fileType}: ${fileName}\nパス: ${filePath}\n\n⚠️ この操作は取り消せません。`;
        
        const confirmed = confirm(message);
        
        if (confirmed) {
            this.deleteFile(fileData);
        }
    }

    async deleteFile(fileData) {
        try {
            console.log('Attempting to delete:', fileData.path);
            const result = await window.electronAPI.deleteFile(fileData.path);
            
            if (result.success) {
                console.log('Successfully deleted:', fileData.path);
                
                // フロントエンドキャッシュを無効化
                this.invalidateCache(fileData.path);
                this.invalidateCache(this.currentPath);
                
                // バックエンドキャッシュも無効化
                try {
                    await window.electronAPI.invalidateDuCache(fileData.path);
                    console.log('Backend DU cache invalidated for:', fileData.path);
                } catch (error) {
                    console.warn('Failed to invalidate backend cache:', error);
                }
                
                // 削除成功後、現在のディレクトリを再読み込み
                this.refreshCurrentDirectory();
                
                // 成功メッセージ（オプション）
                // alert(`${fileData.name} を削除しました`);
            } else {
                console.error('Failed to delete file:', result.error);
                alert(`削除に失敗しました: ${result.error}`);
            }
        } catch (error) {
            console.error('Error in delete operation:', error);
            alert('削除中にエラーが発生しました');
        }
    }

    async openFile(filePath) {
        // Electronのshell.openPathを使用してファイルを開く
        try {
            console.log('Requesting to open file:', filePath);
            const result = await window.electronAPI.openFile(filePath);
            
            if (!result.success) {
                console.error('Failed to open file:', result.error);
                alert(`ファイルを開けませんでした: ${result.error}`);
            } else {
                console.log('Successfully opened file');
            }
        } catch (error) {
            console.error('Error opening file:', error);
            alert('ファイルを開く際にエラーが発生しました');
        }
    }

    async showInFinder(filePath) {
        // Electronのshell.showItemInFolderを使用
        try {
            console.log('Requesting to show in finder:', filePath);
            const result = await window.electronAPI.showInFinder(filePath);
            
            if (!result.success) {
                console.error('Failed to show in finder:', result.error);
                alert(`Finderで表示できませんでした: ${result.error}`);
            } else {
                console.log('Successfully showed in finder');
                if (result.fallback) {
                    console.log('Used fallback method (opened parent directory)');
                }
            }
        } catch (error) {
            console.error('Error showing in finder:', error);
            alert('Finderで表示中にエラーが発生しました');
        }
    }

    showFolderSelection() {
        const overlay = document.getElementById('folderSelectionOverlay');
        overlay.classList.remove('hidden');
    }

    hideFolderSelection() {
        const overlay = document.getElementById('folderSelectionOverlay');
        overlay.classList.add('hidden');
    }

    async showFolderSelectionDialog() {
        try {
            const result = await window.electronAPI.selectFolder();
            
            if (result.success && result.path) {
                console.log('Selected folder:', result.path);
                this.hideFolderSelection();
                this.loadDirectory(result.path);
            } else if (result.canceled) {
                console.log('Folder selection was canceled');
            } else {
                console.error('Error selecting folder:', result.error);
                alert(`フォルダの選択に失敗しました: ${result.error}`);
            }
        } catch (error) {
            console.error('Error in folder selection dialog:', error);
            alert('フォルダ選択ダイアログでエラーが発生しました');
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new DiskUtilityApp();
});