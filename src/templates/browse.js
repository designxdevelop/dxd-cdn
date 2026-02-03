/**
 * Browse/File Browser HTML templates for DXD CDN
 */

/**
 * HTML for the browse password form
 * @param {string} errorMessage - Optional error message
 * @returns {string} Password form HTML
 */
export function getBrowsePasswordHTML(errorMessage = '') {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DXD File Browser</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
            text-align: center;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #555;
        }
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #007bff;
        }
        button {
            background: #007bff;
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
        }
        button:hover {
            background: #0056b3;
        }
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 10px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #f5c6cb;
        }
        .info {
            background: #e7f3ff;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            color: #0056b3;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>DXD File Browser</h1>
        ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
        <div class="info">
            Enter the password to access the file browser and search CDN files.
        </div>
        <form method="POST">
            <div class="form-group">
                <label for="password">Password:</label>
                <input type="password" id="password" name="password" required placeholder="Enter access password" autofocus>
            </div>
            <button type="submit">Access File Browser</button>
        </form>
    </div>
</body>
</html>
`;
}

/**
 * HTML for the file browser interface
 * @param {string} origin - Origin URL for links
 * @param {string} password - Password for API calls
 * @returns {string} File browser HTML
 */
export function getBrowseHTML(origin, password) {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Browser - DXD CDN</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        @media (max-width: 768px) {
            body {
                max-width: 100%;
                padding: 10px;
            }
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        @media (max-width: 768px) {
            .container {
                padding: 20px;
                border-radius: 8px;
            }
        }
        .header-section {
            display: flex;
            align-items: center;
            gap: 20px;
            margin-bottom: 25px;
            flex-wrap: nowrap;
            overflow: hidden;
        }
        h1 {
            color: #333;
            margin: 0;
            flex: 0 0 auto;
            white-space: nowrap;
            font-size: clamp(1.5rem, 3vw, 2rem);
        }
        .search-container {
            flex: 1;
            min-width: 250px;
            max-width: 600px;
        }
        .search-input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #ddd;
            border-radius: 8px;
            font-size: 16px;
            box-sizing: border-box;
            transition: border-color 0.2s;
        }
        .search-input:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
        }
        @media (max-width: 768px) {
            .header-section {
                flex-direction: column;
                align-items: stretch;
                gap: 15px;
            }
            h1 {
                text-align: center;
            }
            .search-container {
                min-width: auto;
                max-width: none;
            }
        }
        .file-list {
            max-height: 600px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 8px;
            background: #fafafa;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 14px 20px;
            border-bottom: 1px solid #eee;
            transition: background-color 0.2s;
            gap: 15px;
        }
        .file-item:hover {
            background-color: #f8f9fa;
        }
        .file-item:last-child {
            border-bottom: none;
        }
        .file-name {
            flex: 3;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 14px;
            word-break: break-all;
            min-width: 200px;
            cursor: context-menu;
        }
        .file-url {
            flex: 4;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 13px;
            color: #666;
            word-break: break-all;
            background: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid #e9ecef;
            min-width: 300px;
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }
        .file-url:hover {
            background: #e9ecef;
            border-color: #007bff;
            color: #007bff;
        }
        .file-url.copied {
            background: #d4edda !important;
            border-color: #28a745 !important;
            color: #155724 !important;
        }
        .copy-btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 8px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .copy-btn:hover {
            background: #0056b3;
            transform: translateY(-1px);
        }
        .copy-btn.copied {
            background: #28a745;
        }
        @media (max-width: 1024px) {
            .file-item {
                flex-direction: column;
                align-items: stretch;
                gap: 10px;
                padding: 12px 15px;
            }
            .file-name {
                min-width: auto;
            }
            .file-url {
                min-width: auto;
                font-size: 12px;
            }
            .copy-btn {
                align-self: flex-end;
                padding: 6px 12px;
                font-size: 12px;
            }
        }
        .no-files {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .nav-links {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 25px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            flex-wrap: wrap;
        }
        .nav-links a {
            color: #007bff;
            text-decoration: none;
            font-weight: 500;
            padding: 8px 16px;
            border-radius: 6px;
            transition: all 0.2s;
        }
        .nav-links a:hover {
            background: #f8f9fa;
            transform: translateY(-1px);
        }
        .stats {
            color: #666;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
        }
        .controls-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            gap: 20px;
            flex-wrap: wrap;
        }
        .filter-group {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            align-items: center;
        }
        .filter-label {
            font-size: 13px;
            font-weight: 500;
            color: #666;
        }
        .filter-btn {
            padding: 8px 14px;
            border: 2px solid #ddd;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .filter-btn:hover {
            border-color: #007bff;
            transform: translateY(-1px);
        }
        .filter-btn.active {
            background: #007bff;
            color: white;
            border-color: #007bff;
            box-shadow: 0 2px 4px rgba(0,123,255,0.2);
        }
        .filter-select {
            padding: 8px 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 13px;
            background: white;
            cursor: pointer;
        }
        .filter-select:focus {
            outline: none;
            border-color: #007bff;
        }
        @media (max-width: 768px) {
            .controls-bar {
                flex-direction: column;
                align-items: stretch;
                gap: 15px;
            }
            .filter-group {
                justify-content: center;
            }
        }
        .badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            margin-right: 8px;
        }
        .badge.prod {
            background: #28a745;
            color: white;
        }
        .badge.staging {
            background: #ffc107;
            color: #212529;
        }
        .badge.client {
            background: #6c757d;
            color: white;
        }
        .context-menu {
            position: fixed;
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            padding: 4px 0;
            z-index: 1000;
            min-width: 150px;
            display: none;
        }
        .context-menu.show {
            display: block;
        }
        .context-menu-item {
            padding: 10px 16px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .context-menu-item:hover {
            background: #f8f9fa;
        }
        .context-menu-item.danger {
            color: #dc3545;
        }
        .context-menu-item.danger:hover {
            background: #fff5f5;
        }
        .stats-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2000;
        }
        .stats-modal-content {
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }
        .stats-modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px;
            border-bottom: 1px solid #eee;
        }
        .stats-modal-header h2 {
            margin: 0;
            color: #333;
            font-size: 20px;
        }
        .stats-modal-close {
            background: none;
            border: none;
            font-size: 28px;
            cursor: pointer;
            color: #666;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
        }
        .stats-modal-close:hover {
            background: #f0f0f0;
            color: #333;
        }
        .stats-modal-body {
            padding: 20px;
        }
        .stat-item {
            margin-bottom: 16px;
            padding-bottom: 16px;
            border-bottom: 1px solid #eee;
        }
        .stat-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }
        .stat-label {
            font-size: 13px;
            color: #666;
            font-weight: 500;
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-value {
            font-size: 18px;
            color: #333;
            font-weight: 600;
        }
        .stat-value.large {
            font-size: 32px;
            color: #007bff;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-section">
            <h1>DXD File Browser</h1>
            <div class="search-container">
                <input type="text" id="search-input" class="search-input" placeholder="Search files... (fuzzy search)" autocomplete="off">
            </div>
        </div>

        <div class="controls-bar">
            <div class="filter-group">
                <span class="filter-label">Client:</span>
                <select id="client-filter" class="filter-select">
                    <option value="all">All Clients</option>
                </select>
            </div>
            <div class="filter-group">
                <span class="filter-label">Project:</span>
                <select id="project-filter" class="filter-select">
                    <option value="all">All Projects</option>
                </select>
            </div>
            <div class="filter-group">
                <button class="filter-btn active" data-env="all">All</button>
                <button class="filter-btn" data-env="prod">Prod</button>
                <button class="filter-btn" data-env="staging">Staging</button>
            </div>
            <div id="stats" class="stats">Loading files...</div>
        </div>

        <div id="file-list" class="file-list">
            <div class="loading">Loading files...</div>
        </div>

        <div class="nav-links">
            <a href="/upload">Upload Files</a>
            <a href="${origin}">Home</a>
        </div>
    </div>

    <div id="context-menu" class="context-menu">
        <div class="context-menu-item" onclick="contextMenuStats()">View Stats</div>
        <div class="context-menu-item danger" onclick="contextMenuDelete()">Delete File</div>
    </div>

    <div id="stats-modal" class="stats-modal" style="display: none;">
        <div class="stats-modal-content">
            <div class="stats-modal-header">
                <h2>File Statistics</h2>
                <button class="stats-modal-close" onclick="closeStatsModal()">&times;</button>
            </div>
            <div class="stats-modal-body" id="stats-modal-body">
                <div class="loading">Loading stats...</div>
            </div>
        </div>
    </div>

    <script>
        let searchTimeout;
        const searchInput = document.getElementById('search-input');
        const fileList = document.getElementById('file-list');
        const statsEl = document.getElementById('stats');
        const clientFilter = document.getElementById('client-filter');
        const projectFilter = document.getElementById('project-filter');
        const password = '${password}';
        let currentEnv = 'all';
        let currentClient = 'all';
        let currentProject = 'all';
        let contextMenuFilePath = null;
        const contextMenu = document.getElementById('context-menu');

        function parseFilePath(filepath) {
            const parts = filepath.split('/');
            if (parts.length < 4) return null;
            return {
                client: parts[0],
                project: parts[1],
                env: parts[2],
                file: parts.slice(3).join('/')
            };
        }

        async function loadFiles() {
            try {
                fileList.innerHTML = '<div class="loading">Loading files...</div>';

                const params = new URLSearchParams({
                    password: password,
                    search: searchInput.value,
                    client: currentClient,
                    project: currentProject,
                    env: currentEnv
                });

                const response = await fetch('/api/files?' + params);
                const data = await response.json();

                if (data.error) {
                    fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                    statsEl.textContent = 'Error loading files';
                    return;
                }

                const files = data.files || [];
                const clients = data.clients || [];
                const projects = data.projects || [];

                // Update client filter
                const currentClientValue = clientFilter.value;
                clientFilter.innerHTML = '<option value="all">All Clients</option>';
                clients.forEach(c => {
                    clientFilter.innerHTML += '<option value="' + c + '"' + (c === currentClientValue ? ' selected' : '') + '>' + c + '</option>';
                });

                // Update project filter (show projects for selected client)
                const currentProjectValue = projectFilter.value;
                projectFilter.innerHTML = '<option value="all">All Projects</option>';
                projects.forEach(p => {
                    if (currentClient === 'all' || p.startsWith(currentClient + '/')) {
                        projectFilter.innerHTML += '<option value="' + p + '"' + (p === currentProjectValue ? ' selected' : '') + '>' + p + '</option>';
                    }
                });

                if (files.length === 0) {
                    fileList.innerHTML = '<div class="no-files">No files found</div>';
                    statsEl.textContent = searchInput.value ? 'No files match "' + searchInput.value + '"' : 'No files in CDN';
                    return;
                }

                statsEl.textContent = 'Found ' + files.length + ' file' + (files.length === 1 ? '' : 's') + (searchInput.value ? ' matching "' + searchInput.value + '"' : '');

                fileList.innerHTML = files.map(filepath => {
                    const url = '${origin}/' + filepath;
                    const filename = filepath.split('/').pop();
                    const parsed = parseFilePath(filepath);
                    
                    let badges = '';
                    if (parsed) {
                        badges += '<span class="badge client">' + parsed.client + '</span>';
                        if (parsed.env === 'staging') {
                            badges += '<span class="badge staging">staging</span>';
                        } else if (parsed.env === 'prod') {
                            badges += '<span class="badge prod">prod</span>';
                        }
                    }

                    const extension = filename.split('.').pop().toLowerCase();
                    const isHtml = extension === 'html' || extension === 'htm';

                    if (isHtml) {
                        return '<div class="file-item">' +
                            '<div class="file-name" data-filepath="' + filepath + '" oncontextmenu="showContextMenu(event, \\'' + filepath + '\\')">' + badges + filename + '</div>' +
                            '<div class="file-url" onclick="copyHtmlContent(\\'' + filepath + '\\', this)">' + url + '</div>' +
                            '<button class="copy-btn" onclick="copyHtmlContent(\\'' + filepath + '\\', this)">Copy Content</button>' +
                        '</div>';
                    } else {
                        return '<div class="file-item">' +
                            '<div class="file-name" data-filepath="' + filepath + '" oncontextmenu="showContextMenu(event, \\'' + filepath + '\\')">' + badges + filename + '</div>' +
                            '<div class="file-url" onclick="copyToClipboard(\\'' + url + '\\', this)">' + url + '</div>' +
                            '<button class="copy-btn" onclick="copyToClipboard(\\'' + url + '\\', this)">Copy</button>' +
                        '</div>';
                    }
                }).join('');

            } catch (error) {
                console.error('Error loading files:', error);
                fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                statsEl.textContent = 'Error loading files';
            }
        }

        function copyToClipboard(text, element) {
            navigator.clipboard.writeText(text).then(() => {
                if (element.tagName === 'BUTTON') {
                    const originalText = element.textContent;
                    element.textContent = 'Copied!';
                    element.classList.add('copied');
                    setTimeout(() => {
                        element.textContent = originalText;
                        element.classList.remove('copied');
                    }, 2000);
                } else {
                    element.classList.add('copied');
                    setTimeout(() => element.classList.remove('copied'), 2000);
                }
            });
        }

        async function copyHtmlContent(filepath, element) {
            try {
                const originalText = element.textContent;
                element.textContent = 'Loading...';
                element.disabled = true;

                const response = await fetch('/api/file-content?password=' + encodeURIComponent(password) + '&file=' + encodeURIComponent(filepath));
                const data = await response.json();

                if (data.error) throw new Error(data.error);

                await navigator.clipboard.writeText(data.content);
                element.textContent = 'Copied!';
                element.classList.add('copied');

                setTimeout(() => {
                    element.textContent = originalText;
                    element.classList.remove('copied');
                    element.disabled = false;
                }, 2000);
            } catch (error) {
                console.error('Failed to copy HTML content:', error);
                const originalText = element.textContent;
                element.textContent = 'Error';
                setTimeout(() => {
                    element.textContent = originalText;
                    element.disabled = false;
                }, 2000);
            }
        }

        function showContextMenu(event, filepath) {
            event.preventDefault();
            contextMenuFilePath = filepath;
            contextMenu.classList.add('show');
            contextMenu.style.left = event.pageX + 'px';
            contextMenu.style.top = event.pageY + 'px';
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu')) {
                contextMenu.classList.remove('show');
                contextMenuFilePath = null;
            }
        });

        async function contextMenuStats() {
            if (!contextMenuFilePath) return;
            
            const filepath = contextMenuFilePath;
            contextMenu.classList.remove('show');
            
            const modal = document.getElementById('stats-modal');
            const modalBody = document.getElementById('stats-modal-body');
            modal.style.display = 'flex';
            modalBody.innerHTML = '<div class="loading">Loading stats...</div>';
            
            try {
                const response = await fetch('/api/file-stats?password=' + encodeURIComponent(password) + '&file=' + encodeURIComponent(filepath));
                const stats = await response.json();
                
                if (stats.error) throw new Error(stats.error);
                
                const formatDate = (dateStr) => {
                    if (!dateStr) return 'Never';
                    return new Date(dateStr).toLocaleString();
                };
                
                modalBody.innerHTML = 
                    '<div class="stat-item"><div class="stat-label">Total Requests</div><div class="stat-value large">' + (stats.requestCount || 0) + '</div></div>' +
                    '<div class="stat-item"><div class="stat-label">First Served</div><div class="stat-value">' + formatDate(stats.firstServed) + '</div></div>' +
                    '<div class="stat-item"><div class="stat-label">Last Served</div><div class="stat-value">' + formatDate(stats.lastServed) + '</div></div>' +
                    '<div class="stat-item"><div class="stat-label">File Path</div><div class="stat-value" style="font-size: 12px; font-family: monospace; word-break: break-all; color: #666;">' + filepath + '</div></div>';
            } catch (error) {
                modalBody.innerHTML = '<div class="no-files">Error loading statistics</div>';
            }
        }

        function closeStatsModal() {
            document.getElementById('stats-modal').style.display = 'none';
            contextMenuFilePath = null;
        }

        document.getElementById('stats-modal').addEventListener('click', (e) => {
            if (e.target.id === 'stats-modal') closeStatsModal();
        });

        let deleteConfirmInProgress = false;
        async function contextMenuDelete() {
            if (!contextMenuFilePath) return;
            
            const filepath = contextMenuFilePath;
            contextMenu.classList.remove('show');
            contextMenuFilePath = null;

            if (!deleteConfirmInProgress) {
                deleteConfirmInProgress = true;
                const confirmMsg = document.createElement('div');
                confirmMsg.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #fff3cd; border: 2px solid #ffc107; padding: 15px 20px; border-radius: 8px; z-index: 2000; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-weight: 500;';
                confirmMsg.innerHTML = 'Right-click the file again to confirm deletion';
                document.body.appendChild(confirmMsg);
                setTimeout(() => {
                    deleteConfirmInProgress = false;
                    document.body.removeChild(confirmMsg);
                }, 4000);
                return;
            }

            deleteConfirmInProgress = false;

            try {
                const response = await fetch('/api/delete-file?password=' + encodeURIComponent(password) + '&file=' + encodeURIComponent(filepath), { method: 'DELETE' });
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                loadFiles();
            } catch (error) {
                console.error('Failed to delete file:', error);
                alert('Failed to delete file');
            }
        }

        // Load files on page load
        loadFiles();

        // Handle search input
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(loadFiles, 300);
        });

        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(searchTimeout);
                loadFiles();
            }
        });

        // Handle environment filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentEnv = btn.dataset.env;
                loadFiles();
            });
        });

        // Handle client filter
        clientFilter.addEventListener('change', () => {
            currentClient = clientFilter.value;
            currentProject = 'all'; // Reset project when client changes
            loadFiles();
        });

        // Handle project filter
        projectFilter.addEventListener('change', () => {
            currentProject = projectFilter.value;
            loadFiles();
        });
    </script>
</body>
</html>
`;
}
