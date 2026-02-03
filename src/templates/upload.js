/**
 * Upload HTML templates for DXD CDN
 */

/**
 * HTML for the upload form
 */
export const UPLOAD_FORM_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Upload - DXD CDN</title>
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
        input[type="password"], input[type="file"], input[type="text"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }
        input:focus {
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
        .info {
            background: #e7f3ff;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            color: #0056b3;
        }
        .optional {
            color: #888;
            font-size: 12px;
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>DXD CDN File Upload</h1>
        <div class="info">
            Upload files to the CDN. After upload, you'll get a shareable link.
        </div>
        <form method="POST" enctype="multipart/form-data">
            <div class="form-group">
                <label for="password">Password:</label>
                <input type="password" id="password" name="password" required placeholder="Enter upload password">
            </div>
            <div class="form-group">
                <label for="path">Upload Path (optional):</label>
                <input type="text" id="path" name="path" placeholder="e.g., client-name/project/prod">
                <div class="optional">Leave empty to upload to root. Use format: client/project/env</div>
            </div>
            <div class="form-group">
                <label for="file">Choose File:</label>
                <input type="file" id="file" name="file" required>
            </div>
            <button type="submit">Upload File</button>
        </form>
    </div>
</body>
</html>
`;

/**
 * HTML for successful upload
 * @param {string} filename - Uploaded filename
 * @param {string} cdnUrl - Full CDN URL
 * @returns {string} Success HTML
 */
export function getSuccessHTML(filename, cdnUrl) {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Upload Success - DXD CDN</title>
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
        .success {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        .url-container {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
        }
        .url-input {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-family: monospace;
            font-size: 14px;
            box-sizing: border-box;
        }
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            text-decoration: none;
            text-align: center;
            font-size: 14px;
            flex: 1;
        }
        .btn-primary {
            background: #007bff;
            color: white;
        }
        .btn-secondary {
            background: #6c757d;
            color: white;
        }
        .btn:hover {
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Upload Successful!</h1>
        <div class="success">
            File "${filename}" has been uploaded successfully.
        </div>
        
        <div class="url-container">
            <label for="cdn-url"><strong>Your CDN URL:</strong></label>
            <input type="text" id="cdn-url" class="url-input" value="${cdnUrl}" readonly onclick="this.select()">
        </div>
        
        <div class="button-group">
            <button class="btn btn-primary" onclick="copyToClipboard()">Copy URL</button>
            <a href="${cdnUrl}" target="_blank" class="btn btn-secondary">Open File</a>
        </div>
        
        <div style="margin-top: 20px; text-align: center;">
            <a href="/upload">Upload Another File</a>
        </div>
    </div>
    
    <script>
        function copyToClipboard() {
            const urlInput = document.getElementById('cdn-url');
            urlInput.select();
            document.execCommand('copy');
            
            const btn = event.target;
            const originalText = btn.textContent;
            btn.textContent = 'Copied!';
            btn.style.background = '#28a745';
            
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '#007bff';
            }, 2000);
        }
    </script>
</body>
</html>
`;
}

/**
 * HTML for upload error
 * @param {string} message - Error message
 * @returns {string} Error HTML
 */
export function getUploadErrorHTML(message) {
	return `
<!DOCTYPE html>
<html>
<head>
    <title>Upload Error - DXD CDN</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            text-align: center;
            margin-top: 50px;
            background: #f5f5f5;
        }
        .container {
            max-width: 500px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        a {
            color: #007bff;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Upload Failed</h1>
        <div class="error">${message}</div>
        <a href="/upload">Go Back</a>
    </div>
</body>
</html>
`;
}
