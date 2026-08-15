# DXD CDN

A hybrid CDN using Cloudflare Workers and R2 storage. Supports file upload/browsing with multi-client organization, GitHub proxy with versioning/minification, direct R2 file serving, and a **programmatic Objects API** (`PUT|GET /api/objects`) with a shared TypeScript client (`packages/client` → `@dxd/cdn`) for any DXD project.

## Features

### File Management
- 📤 Web-based file upload with password protection
- 📂 File browser with fuzzy search and filters (client/project/env)
- 📊 File analytics tracking (request count, first/last served)
- 🗑️ File deletion via API
- 🎬 MP4 streaming with range request support
- 🔁 Live URLs revalidate in the browser (republish without a hard refresh)
- 📦 Objects API + `@dxd/cdn` client (and optional `CdnObjects` Worker binding)

### GitHub Proxy (Legacy)
- 🌍 Global CDN via Cloudflare's edge network
- 📦 Serves files from public and private GitHub repositories
- 🏷️ Version control support (releases and commit hashes)
- 🔄 Automatic minification for JS and CSS files
- 💾 R2 caching for improved performance
- 🗜️ Automatic compression for script/link requests

### Tools
- 🔄 JSDelivr URL conversion support
- 🚀 Pre-caching option for faster delivery

## Project Structure

```
src/
  index.js              # Main entry point, request routing
  config/
    constants.js        # Content types, preview types, GitHub config, cache policies
  handlers/
    api.js              # /api/files, /api/file-stats, …
    browse.js           # File browser UI
    objects-api.js      # PUT|GET /api/objects (HTTP adapter)
    responses.js        # R2 and GitHub response handling
    streaming.js        # MP4 streaming support
    upload.js           # File upload handling
  services/
    cdn-objects.js      # CdnObjects WorkerEntrypoint (service binding)
    github.js           # GitHub API integration
    minification.js     # Basic JS/CSS minification
    objects.js          # R2 put/get (no HTTP statuses)
  templates/
    browse.js           # Browse page HTML templates
    pages.js            # Special pages (speed-test, convert)
    upload.js           # Upload page HTML templates
  utils/
    cache.js            # Public GET Cache-Control / ETag / 304
    compression.js      # Gzip compression utilities
    cors.js             # CORS handling utilities
    files.js            # File operations, fuzzy search, analytics
    r2.js               # Key fallback + conditional GET
packages/
  client/               # @dxd/cdn TypeScript client
```

## Setup Instructions

### 1. Cloudflare Setup

1. Create a Cloudflare account if you don't have one
2. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```
3. Login to Cloudflare via Wrangler:
   ```bash
   wrangler login
   ```

### 2. R2 Bucket Setup

1. Create an R2 bucket in Cloudflare Dashboard:
   - Go to R2 section
   - Click "Create bucket"
   - Name it `dxd-cdn` (or update wrangler.toml if using a different name)

2. Update wrangler.toml with your bucket details (already configured if using default name)

### 3. Secrets Setup

```bash
# Required for file upload/browse authentication
wrangler secret put UPLOAD_PASSWORD

# Required for GitHub proxy functionality
wrangler secret put GITHUB_TOKEN
```

For the GitHub token:
- Go to GitHub.com → Settings → Developer Settings → Personal Access Tokens
- Select scopes: `public_repo` (public only) or `repo` (private repos)

### 4. Custom Domain Setup (Optional)

1. Add your domain in Cloudflare Dashboard:
   - Go to Workers & Pages → Select your worker → Add Custom Domain

2. Update wrangler.toml:
   ```toml
   routes = [
       { pattern = "your-domain.com", custom_domain = true }
   ]
   ```

## Deployment

```bash
npm install
npm run deploy
```

## Usage

### File Upload

Visit `https://your-domain.com/upload` to:
- Upload files with password authentication
- Specify upload path (client/project/env structure recommended)
- Auto-generates unique filenames if conflicts exist

### File Browser

Visit `https://your-domain.com/browse` to:
- Browse all uploaded files
- Search with fuzzy matching
- Filter by client, project, or environment
- View file analytics
- Delete files
- Copy CDN URLs

### Direct File Access

```
https://your-domain.com/[client]/[project]/[env]/[filename]
```

Example:
```
https://your-domain.com/acme/website/prod/hero-image.webp
```

Query parameters:
- `?download=true` - Force download instead of inline display

Public GET honors the object's stored `Cache-Control`. Unchanged files return `304` on `If-None-Match` or `If-Modified-Since`.

### Objects API

Programmatic publish/pull for Studio, Heard, client Workers, and CI. Prefer this over rclone so each object gets a `Cache-Control`.

```
PUT /api/objects
Authorization: Bearer <UPLOAD_PASSWORD>
X-DXD-Object-Key: heard/hp/prod/personalization.js
X-DXD-Cache-Control: public, max-age=0, must-revalidate   # omit for this default
```

`X-DXD-Cache-Control` allowlists two values (anything else is 400):

| Use | Value |
| --- | --- |
| Live pointer (`config.json`, `personalization.js`, `/upload`) | `public, max-age=0, must-revalidate` (PUT default) |
| Hashed / versioned snapshot | `public, max-age=31536000, immutable` |

Shared client: `packages/client` (`@dxd/cdn`) — `putObject`, `publishHashedAsset` (snapshot **then** live), `publishVersioned`. Same-account Workers can bind `CdnObjects` instead of sending the password over HTTP; that binding can write **any** key in the bucket.

Headers and Worker recipe: [docs/api-objects.md](docs/api-objects.md), [docs/connect-a-worker.md](docs/connect-a-worker.md).

### GitHub Proxy (Legacy)

```
https://your-domain.com/[repo-name]/[version]/[file-path]
```

Where `version` can be:
- A release tag: `v1.0.0`
- A commit hash: `a1b2c3d`
- Latest release: `latest`

Examples:
```
# Specific version
https://your-domain.com/my-project/v1.0.0/dist/script.js

# Minified version (add .min before extension)
https://your-domain.com/my-project/v1.0.0/dist/script.min.js

# Latest release
https://your-domain.com/my-project/latest/dist/script.js
```

### URL Converter Tool

Visit `https://your-domain.com/convert` for a web interface to:
- Convert GitHub URLs to CDN URLs
- Convert JSDelivr URLs to CDN URLs
- Select versions or commit hashes
- Toggle minification
- Pre-cache files

## API Endpoints

Auth: `Authorization: Bearer <UPLOAD_PASSWORD>` or `?password=` (same secret as `/upload`). JSON APIs send `Cache-Control: no-store`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/objects` | PUT | Store an object (`X-DXD-Object-Key`, optional `X-DXD-Cache-Control` / `X-DXD-Overwrite`) |
| `/api/objects` | GET | Authenticated meta or body (`?key=` and `as=meta` or `as=body`) |
| `/api/files` | GET | List files with optional search/filter |
| `/api/file-stats` | GET | Get analytics for a specific file |
| `/api/file-content` | GET | Get HTML file content |
| `/api/delete-file` | DELETE | Delete a file |

### Query Parameters

**`/api/files`**
- `search` - Fuzzy search query
- `client` - Filter by client name
- `project` - Filter by project (format: `client/project`)
- `env` - Filter by environment (`staging` or `prod`)

**`/api/file-stats` and `/api/file-content`**
- `file` - Full file path

**`/api/delete-file`**
- `file` - Full file path to delete

**`/api/objects`**
- `key` - Object key (or `X-DXD-Object-Key` on PUT)
- `as` - `meta` (default) or `body` on GET

## Development

```bash
npm run dev    # Start local dev server
npm run deploy # Deploy to Cloudflare
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UPLOAD_PASSWORD` | Yes | Password for upload/browse/API access |
| `GITHUB_TOKEN` | For GitHub proxy | GitHub Personal Access Token |
| `ENVIRONMENT` | No | Set to "production" in prod |
| `PUBLIC_ORIGIN` | No | Public origin in RPC/service-binding URLs (HTTP handlers use the request origin). Production: `https://cdn.designxdevelop.com` |

## File Path Convention

Recommended structure for uploaded files:
```
/:client/:project/:env/:filename
```

Examples:
- `acme/website/prod/logo.svg`
- `acme/website/staging/hero-video.mp4`
- `bigcorp/landing-page/prod/styles.css`

### Caching Strategy
- GitHub releases cached 5 minutes in-memory
- Hashed / versioned assets (and GitHub `/:repo/:version/:file`): 1 year `immutable`
- Live objects (`config.json`, `personalization.js`, web uploads): `public, max-age=0, must-revalidate` on browser **and** Cloudflare cache headers — no timed edge copy. Next navigation revalidates (`304` if unchanged)
- PUT `/api/objects` allowlists only those two `Cache-Control` strings
- API JSON responses use `no-store`

After deploying this Worker, **republish existing live keys**. Objects already stored as `immutable` (old PUT default, rclone) stay sticky until overwritten.

See [docs/api-objects.md](docs/api-objects.md) and [docs/connect-a-worker.md](docs/connect-a-worker.md).

## Limitations

- Minification only supported for JS and CSS files (basic, Workers-compatible)
- R2 storage limits based on your Cloudflare plan
- GitHub API rate limits apply when fetching new files
- Private repos require `repo` scope GitHub token
