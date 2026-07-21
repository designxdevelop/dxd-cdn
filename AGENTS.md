# DXD CDN - Agent Guidelines

A Cloudflare Worker-based hybrid CDN supporting file upload/browsing, GitHub proxy with
versioning/minification, and direct R2 file serving.

## Build & Development Commands

```bash
# Development
npm run dev          # Start local dev server (wrangler dev)
npm run start        # Alias for dev

# Deployment
npm run deploy       # Deploy to Cloudflare (wrangler deploy)

# Wrangler commands (direct)
wrangler dev                     # Local development with live reload
wrangler deploy                  # Deploy to production
wrangler tail                    # Stream live logs
wrangler secret put SECRET_NAME  # Set secrets (e.g., UPLOAD_PASSWORD, GITHUB_TOKEN)
```

## Project Structure

```
src/
  index.js              # Main entry point, request routing
  config/
    constants.js        # Content types, preview types, GitHub config
  handlers/
    api.js              # API route handlers (/api/files, /api/file-stats, etc.)
    browse.js           # File browser UI
    responses.js        # R2 and GitHub response handling
    streaming.js        # MP4 streaming support
    upload.js           # File upload handling
  services/
    github.js           # GitHub API integration (releases, commits)
    minification.js     # Basic JS/CSS minification
  templates/
    browse.js           # Browse page HTML templates
    pages.js            # Special pages (speed-test, convert)
    upload.js           # Upload page HTML templates
  utils/
    compression.js      # Gzip compression utilities
    cors.js             # CORS handling utilities
    files.js            # File operations, fuzzy search, analytics
```

## Code Style Guidelines

### Formatting (enforced via Prettier)

- **Tabs** for indentation (not spaces)
- **Single quotes** for strings
- **Semicolons** required
- **Print width**: 140 characters
- **LF** line endings
- **Final newline** required in all files

### JavaScript Conventions

- **ES Modules**: Use `import`/`export` syntax (type: "module" in package.json)
- **File extensions**: Always include `.js` in imports
  ```javascript
  // Correct
  import { CONTENT_TYPES } from '../config/constants.js';
  
  // Wrong
  import { CONTENT_TYPES } from '../config/constants';
  ```

### Naming Conventions

- **Functions**: camelCase, descriptive verbs
  ```javascript
  handleUploadPost()     // Handler functions
  getLatestRelease()     // Getters
  validatePassword()     // Validators
  parseFilePath()        // Parsers
  ```
- **Constants**: SCREAMING_SNAKE_CASE for module-level constants
  ```javascript
  const GITHUB_CACHE_TTL = 300000;
  const DEFAULT_GITHUB_OWNER = 'austin-thesing';
  ```
- **Files**: kebab-case for filenames
- **Route handlers**: `handle{Route}{Method}` pattern
  ```javascript
  handleUploadGet()
  handleUploadPost()
  handleFilesApi()
  ```

### Function Documentation

Use JSDoc comments for all exported functions:
```javascript
/**
 * Brief description of what the function does
 * @param {Type} paramName - Parameter description
 * @returns {ReturnType} Return description
 */
export function functionName(paramName) {
  // implementation
}
```

### Error Handling

- Wrap async operations in try/catch
- Log errors with context using `console.error()`
- Return appropriate HTTP status codes and JSON error responses
- Use descriptive error messages

```javascript
try {
  const result = await someAsyncOperation();
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
} catch (error) {
  console.error('Operation failed:', error);
  return new Response(JSON.stringify({ error: 'Operation failed' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### Response Patterns

- Always set `Content-Type` header
- Use CORS headers from `utils/cors.js`
- Set cache headers appropriately:
  ```javascript
  'Cache-Control': 'public, max-age=31536000, immutable'  // Static assets
  'Cache-Control': 'no-cache'                              // API responses
  ```

### Import Organization

1. External/third-party imports (none currently)
2. Config imports
3. Handler imports
4. Service imports
5. Utility imports
6. Template imports

```javascript
import { CONTENT_TYPES, PREVIEW_TYPES } from './config/constants.js';
import { handleUploadGet, handleUploadPost } from './handlers/upload.js';
import { getLatestRelease } from './services/github.js';
import { handleCorsPreflightRequest, getCorsHeaders } from './utils/cors.js';
```

## Cloudflare Workers Specifics

### Environment Bindings

Access via the `env` parameter in fetch handler:
- `env.CDN_BUCKET` - R2 bucket binding
- `env.UPLOAD_PASSWORD` - Secret for upload authentication
- `env.GITHUB_TOKEN` - GitHub API token
- `env.ENVIRONMENT` - "production" in prod

### Worker Entry Point Pattern

```javascript
export default {
  async fetch(request, env, ctx) {
    // Request handling
    // Use ctx.waitUntil() for background tasks (e.g., caching)
  },
};
```

### R2 Operations

```javascript
// Get object
const object = await env.CDN_BUCKET.get(path);

// Put object
await env.CDN_BUCKET.put(key, body, { httpMetadata: { contentType } });

// Delete object
await env.CDN_BUCKET.delete(key);

// List objects
const objects = await env.CDN_BUCKET.list();
```

## Testing

No test framework configured. Manual testing via:
```bash
npm run dev   # Start local server
# Test endpoints manually with curl or browser
```

## Key Patterns

### Password Validation
Protected routes accept `Authorization: Bearer` or query `?password=` against `env.UPLOAD_PASSWORD`.

### File Path Structure
Uploaded files follow: `/:client/:project/:env/:filename`
GitHub proxy follows: `/:repo/:version/:filepath`

### Objects API (multi-project)
- `PUT|GET /api/objects` — project-agnostic put/pull; see `docs/api-objects.md`
- Shared TS client: `packages/client` (`@dxd/cdn`) — use from any DXD repo
- Per-object `Cache-Control` via `X-DXD-Cache-Control` (honored on public GET)

### Caching Strategy
- GitHub releases cached 5 minutes in-memory
- Default static assets: 1 year `immutable`
- Mutable live objects (e.g. Studio `config.json`): short TTL set by the publisher
- API list/stats responses use `no-cache`

## Cursor Cloud specific instructions

Dependencies are already installed by the startup update script (`npm install`, which also links the `packages/client` workspace). Node 22 / npm 10 are available.

### Running the app locally
- `npm run dev` (alias `npm run start`) runs `wrangler dev` on `http://localhost:8787`. Wrangler/Miniflare provides a **local R2 emulator** for the `CDN_BUCKET` binding by default — no Cloudflare account, login, or real R2 bucket is needed for local end-to-end testing. Do NOT use `--remote` (it would require real Cloudflare credentials).
- Auth-gated routes (`/upload`, `/browse`, all `/api/*`, and Objects API writes) require `UPLOAD_PASSWORD`. For local dev, set it in a gitignored `.dev.vars` file at the repo root, e.g. `UPLOAD_PASSWORD=devpassword123`. Without it these routes return 401. Wrangler auto-loads `.dev.vars`; changing it requires restarting `wrangler dev`.
- `GITHUB_TOKEN` is only needed to exercise the GitHub proxy path (`/:repo/:version/:file`); the file CDN, browse UI, and Objects API work without it.
- Local R2 state persists under `.wrangler/` (gitignored) between dev runs.

### Testing / checks
- `npm run typecheck` (tsc) and `npm test` (vitest) both only cover the `@dxd/cdn` client in `packages/client`. There is no test coverage or lint script for the Worker `src/` code — validate Worker changes by running `wrangler dev` and hitting endpoints with curl/browser.
- No linter is wired up (no ESLint/Prettier in devDependencies) despite the style guide above; formatting is not enforced by a command.
- Quick smoke test once dev server is up: `PUT /api/objects` with header `Authorization: Bearer <UPLOAD_PASSWORD>` and `X-DXD-Object-Key`, then confirm via `GET /api/objects?key=...&password=<pw>`, public `GET /<key>`, and the `/browse?password=<pw>` UI.
