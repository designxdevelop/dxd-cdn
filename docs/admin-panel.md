# Admin panel

`https://cdn.designxdevelop.com/admin` is the one place to browse, upload,
replace, restore, purge and delete files, to see storage and traffic, to review
who changed what, and to manage app tokens. It
replaces the old `/browse` and `/upload` pages, which redirect to it.

## What it does

- **Folders.** Keys are browsed as folders (`client/project/env/...`) with a
  file count and total size per folder. The address bar tracks the folder, so
  back, forward and bookmarks work. "Show all files" flattens everything under
  the current folder, and search always looks through the whole subtree.
- **Previews.** Image thumbnails in the list; images, video, audio and the
  first 64 KB of text files in the detail view.
- **Bulk actions.** Tick files (or the header box for all shown) to copy every
  URL, purge them from the edge, or delete them.
- **Copy as.** The URL, or a ready-made tag for the file type: a script,
  stylesheet, image, video or audio tag, or an `@font-face` rule.
- **Rename or move.** Copies to the new path with the same metadata and removes
  the old one. Never overwrites. The old URL stops working, so this is
  owner-only like delete.
- **Upload.** Drop files or whole folders anywhere on the page to upload into
  the folder you are in, keeping the dropped folder structure. An existing file
  is only replaced when you click Replace.
- **Storage.** Storage totals, storage by client, largest and newest files, and
  the Worker's own request counts.
- **Earlier versions.** Replacing or deleting a file keeps the outgoing copy.
  The file's detail view lists them with a Restore button. See
  [Versions and activity](#versions-and-activity).
- **Activity.** Every upload, replace, rename, delete and restore, and every app
  token created or revoked, with who did it. Deletes and replaces have a
  Restore or Undo button while the copy is kept.
- **Traffic.** Requests, data sent, share answered from the edge cache, the
  busiest files and the paths people request that do not exist, for the last
  24 hours, 7 days or 30 days. See [Traffic](#traffic).
- **Clean-up.** Files uploaded before a cut-off that nobody has requested
  since, largest first, ready to select and delete.
- **Tokens** (owners only). Create and revoke app tokens. See
  [App tokens](#app-tokens).

Thumbnails and media previews load from the public URL, so they count as
ordinary requests. The text preview goes through `/admin/api/preview`, which
always answers `text/plain` with `nosniff` and a sandbox CSP, so stored HTML or
SVG can never run on the admin origin. The Worker's own counters skip
same-origin requests (`Sec-Fetch-Site: same-origin`), so looking at a file in
the panel does not make it look used.

## Versions and activity

Both are bookkeeping objects in the same bucket, under the reserved `_cdn/`
prefix, so no app token can write or forge them and the public path never
serves them. They are written by the storage layer (`src/services/objects.js`),
so changes made through the Objects API and the `CdnObjects` binding are
recorded exactly like changes made in the panel.

- `_cdn/versions/<key>?<id>` is the copy a replace or delete pushed out. The
  newest 5 per file are kept, for 30 days. Files over 100 MB and files marked
  as never changing (which cannot be replaced) are not copied.
- `_cdn/activity/<id>` is one empty object per change, with the event in its
  custom metadata. Kept for 180 days.

A cron trigger (`[triggers]` in `wrangler.toml`) runs the clean-up of both once
a night. Deleting therefore frees the storage after 30 days, not at once.

Restoring puts a kept copy back at its path and purges the edge cache. Whatever
was there is kept as a version first, so a restore can be undone. Anyone who can
sign in can restore, the same as replacing.

## App tokens

An owner creates a token in the Tokens tab by naming the app, the folders it
may use and what it may do there (upload, read, list, delete). The token is
shown once. Only its SHA-256 is stored, at `_cdn/tokens/<sha256>.json`, so
nobody, including the panel, can show it again. Revoking deletes that object and
the token stops working on the next request.

A panel token is always limited to named folders: it cannot cover the whole
bucket or a reserved prefix. Tokens in the `APP_TOKENS` secret keep working and
are listed read-only.

This is the one place the panel hands a credential to the browser: a token that
did not exist a moment ago, to the owner who asked for it, in a `no-store`
response.

## Traffic

The Worker's counters only see requests that reach the Worker, so anything
answered from the edge cache is invisible to them. The Traffic tab instead asks
Cloudflare's GraphQL Analytics API, which counts every request to the hostname.
It needs two settings, and shows "not connected" until both are there:

1. Create an API token with only **Zone → Analytics → Read** on the zone, and
   store it: `npx wrangler secret put CF_ANALYTICS_TOKEN`.
2. Put the zone's id (dashboard → the domain → Overview → Zone ID) in
   `CF_ZONE_ID` in `wrangler.toml` and deploy.

The token stays in the Worker. The browser only ever gets the numbers.

With traffic connected, Clean-up also checks its list against every path
Cloudflare saw requested in the last 30 days. Without it, Clean-up relies on the
Worker's counters and says so: treat that list as one to review.

## How sign-in works

There is no password. [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
sits in front of `/admin`, sends people through your identity provider, and adds
a signed JWT (`Cf-Access-Jwt-Assertion`) to every request it lets through. The
Worker then checks that JWT itself on every request, page and API alike:

- signature against the team's public keys (RS256 only; the token cannot choose its algorithm)
- issuer is this team's Access domain
- audience is this Access application
- not expired
- carries an email (a service token is refused)

So the panel is closed unless **both** layers agree. If the Access application
is ever removed or its path changed, the Worker still refuses every request,
because nothing can mint a valid assertion. If `ACCESS_TEAM_DOMAIN` or
`ACCESS_AUD` is empty, `/admin` answers `503` rather than opening.

What the browser holds is only the Access session cookie. It never receives
`UPLOAD_PASSWORD`, the analytics token or any existing bucket token, and no
credential appears in a URL. The single exception is an app token at the moment
an owner creates it (see [App tokens](#app-tokens)).

Other protections on the panel:

- **Writes are same-origin only.** Upload, delete and purge need an `Origin`
  header equal to the CDN origin plus an `X-DXD-Admin` header, so another site
  cannot ride a signed-in session.
- **Strict Content-Security-Policy** with a per-response nonce. File names are
  rendered as text, never as HTML, and nothing inline can run without the nonce.
- **No cross-origin access.** Admin responses carry no CORS headers, are
  `no-store`, and cannot be framed.
- **Owners delete, everyone else does not.** Only emails in `ADMIN_OWNERS` can
  delete, rename or move. Other signed-in people can browse, upload, replace
  and purge. With
  `ADMIN_OWNERS` empty, nobody can delete from the panel. The rule is enforced
  in the storage layer's scope check, not just hidden in the page.
- **Owners manage tokens.** Listing, creating and revoking app tokens is
  owner-only.
- **Named audit trail.** Every change is in the Activity tab and in Workers
  Logs with `admin:<email>`.
- `admin/` is a reserved key prefix, so no stored object can ever answer under
  `/admin`.

## Who controls access

The Access policy in the Cloudflare dashboard (Zero Trust → Access →
Applications → the CDN admin application). Only Cloudflare account
administrators can change it. From there you can add or remove people, narrow
the rule to a list of emails, shorten the session length, or revoke everyone's
sessions.

## Setup

1. In Zero Trust, add a **self-hosted** Access application:
   - Application domain: `cdn.designxdevelop.com`, path `admin`. Only this
     path, never the whole hostname, or every public file would ask for a login.
   - Policy: **Allow**, include *Emails ending in* `@designxdevelop.com` (or a
     list of emails).
2. Copy the application's **Application Audience (AUD) tag** and your team
   domain (`<team>.cloudflareaccess.com`).
3. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_OWNERS` in `wrangler.toml`
   and deploy.

## Local development

Access cannot run in front of `wrangler dev`. Add to the ignored `.dev.vars`:

```
ENVIRONMENT=development
ADMIN_DEV_EMAIL=you@example.com
ADMIN_OWNERS=you@example.com
```

The stand-in only works when `ENVIRONMENT` is exactly `development`.
`wrangler.toml` sets it to `production` on every deploy.

## The token APIs

`UPLOAD_PASSWORD` and the scoped app tokens still authenticate the HTTP APIs
(`/api/objects`, `/api/files`, …) for CI and other apps, as
`Authorization: Bearer <token>` only. A token in the query string
(`?password=`) is no longer accepted anywhere.
