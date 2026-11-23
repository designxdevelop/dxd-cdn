# Admin panel

`https://cdn.designxdevelop.com/admin` is the one place to browse, upload,
replace, purge and delete files, and to see storage and request counts. It
replaces the old `/browse` and `/upload` pages, which redirect to it.

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
`UPLOAD_PASSWORD` or any bucket token, and no credential appears in a URL.

Other protections on the panel:

- **Writes are same-origin only.** Upload, delete and purge need an `Origin`
  header equal to the CDN origin plus an `X-DXD-Admin` header, so another site
  cannot ride a signed-in session.
- **Strict Content-Security-Policy** with a per-response nonce. File names are
  rendered as text, never as HTML, and nothing inline can run without the nonce.
- **No cross-origin access.** Admin responses carry no CORS headers, are
  `no-store`, and cannot be framed.
- **Owners delete, everyone else does not.** Only emails in `ADMIN_OWNERS` can
  delete. Other signed-in people can browse, upload, replace and purge. With
  `ADMIN_OWNERS` empty, nobody can delete from the panel. The rule is enforced
  in the storage layer's scope check, not just hidden in the page.
- **Named audit trail.** Every upload, delete and manual purge is logged with
  `admin:<email>` in Workers Logs.
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
