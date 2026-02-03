# GitHub Action Setup for DXD CDN

This guide explains how to set up automatic deployments from client GitHub repositories to DXD CDN.

## Overview

The GitHub Action workflow automatically deploys built files to the DXD CDN whenever you push to specific branches:
- **main/master** → Deploys to `prod` environment
- **staging/develop/other** → Deploys to `staging` environment

## File Structure

Files are organized in the CDN bucket using this structure:
```
{client-name}/{project-name}/{environment}/{files}
```

For example:
```
acme-corp/marketing-site/prod/js/main.js
acme-corp/marketing-site/staging/js/main.js
```

CDN URLs follow the same pattern:
```
https://cdn.designxdevelop.com/{client}/{project}/{env}/{path}
```

## Setup Instructions

### 1. Copy the Workflow Template

Copy the workflow template from the dxd-cdn repository to your client project:

```bash
# From your client project root
mkdir -p .github/workflows
curl -o .github/workflows/deploy-to-cdn.yml \
  https://raw.githubusercontent.com/austin-thesing/dxd-cdn/main/.github/workflows/deploy-to-cdn.yml.template
```

Or manually copy the file from:
```
dxd-cdn/.github/workflows/deploy-to-cdn.yml.template
```

### 2. Configure Environment Variables

Edit the workflow file and update the environment variables at the top:

```yaml
env:
  CLIENT_NAME: 'acme-corp'        # Your client's identifier (lowercase, no spaces)
  PROJECT_NAME: 'marketing-site'  # Project identifier (lowercase, no spaces)
  BUILD_DIR: 'dist'               # Directory containing built files
```

**Naming Guidelines:**
- Use lowercase letters, numbers, and hyphens only
- Keep names short but descriptive
- Be consistent across projects for the same client

### 3. Add GitHub Secrets

Go to your repository's **Settings → Secrets and variables → Actions** and add these secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key ID | Cloudflare Dashboard → R2 → Manage R2 API Tokens |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Access Key | Same as above |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID | Cloudflare Dashboard → Overview → Account ID (right sidebar) |

### 4. Configure Build Step (If Needed)

If your project requires a build step before deployment, add it to the workflow:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      # ADD YOUR BUILD STEP HERE
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build
        run: npm run build
      # END BUILD STEP

      - name: Determine environment
        # ... rest of the workflow
```

### 5. Configure Trigger Paths (Optional)

By default, the workflow triggers on changes to `dist/**`, `build/**`, and `src/**`. Update if needed:

```yaml
on:
  push:
    branches:
      - main
      - staging
    paths:
      - 'src/**'        # Source files
      - 'public/**'     # Static assets
      - 'package.json'  # Dependency changes
```

## Usage

### Automatic Deployment

Push to a configured branch to trigger deployment:

```bash
git push origin main      # → Deploys to prod
git push origin staging   # → Deploys to staging
```

### Manual Deployment

1. Go to **Actions** tab in your GitHub repository
2. Select "Deploy to DXD CDN" workflow
3. Click "Run workflow"
4. Choose the environment (auto, staging, or prod)
5. Click "Run workflow"

### Viewing Results

After deployment:
1. Check the **Actions** tab for deployment status
2. Click on the workflow run to see the summary
3. The summary includes all CDN URLs for uploaded files

## CDN URLs

After deployment, your files are available at:

```
https://cdn.designxdevelop.com/{client}/{project}/{env}/{file-path}
```

### Examples

For `acme-corp/marketing-site/prod`:
```html
<!-- JavaScript -->
<script src="https://cdn.designxdevelop.com/acme-corp/marketing-site/prod/js/main.js"></script>

<!-- CSS -->
<link rel="stylesheet" href="https://cdn.designxdevelop.com/acme-corp/marketing-site/prod/css/styles.css">

<!-- Images -->
<img src="https://cdn.designxdevelop.com/acme-corp/marketing-site/prod/images/logo.png">
```

## Troubleshooting

### "Build directory not found"

Make sure your `BUILD_DIR` matches the actual output directory of your build process. Common directories:
- `dist` (Vite, Rollup)
- `build` (Create React App)
- `out` (Next.js static export)
- `.next` (Next.js)
- `public` (some static site generators)

### "Permission denied" or "Access denied"

1. Verify all three secrets are set correctly
2. Make sure the R2 API token has "Edit" permissions
3. Check that the Cloudflare Account ID is correct

### Files not updating

The CDN uses aggressive caching. For immediate updates:
1. Use versioned filenames (e.g., `main.v2.js`)
2. Or add cache-busting query strings (e.g., `main.js?v=123`)
3. Or wait for cache to expire (up to 1 year for immutable assets)

## File Browser

You can browse and manage uploaded files at:
```
https://cdn.designxdevelop.com/browse
```

Features:
- Search files across all clients/projects
- Filter by client, project, and environment
- View file statistics (request count, last served)
- Copy URLs or HTML content directly
- Delete files (with confirmation)

## Support

For issues with the DXD CDN or this workflow:
1. Check the Actions logs for error details
2. Verify your configuration matches the examples
3. Contact the DXD team for assistance
