<p align="center">
  <img src="assets/emblem.png" width="120" alt="honeydrop">
</p>

# honeydrop

A small private upload service that publishes static documents at clean URLs. Drop an HTML file or a Markdown note, get a shareable link back. Built on Node.js and Caddy.

```
make a thing → drop it in → get a URL → share it
```

## How it works

```
upload.yourdomain.com          (Caddy basic auth → honeydrop)
      ↓
  POST /upload
      ↓
  yourdomain.com/s/<slug>/     (Caddy static file_server)
```

- The public site stays static and untouched.
- Published documents live in a separate directory Caddy serves directly.
- The upload service runs locally on `127.0.0.1` — Caddy is the only public entrypoint.
- Markdown files are rendered to HTML. Text files are wrapped in a minimal template. HTML files are served as-is.
- You can drop the document together with the images it references. The images are written into the same published folder, so relative links like `![](diagram.png)` resolve without any rewriting.
- Every published page gets Open Graph / Twitter Card tags (title, description, canonical URL, and an `og:image` derived from the document's first image or `OG_DEFAULT_IMAGE`), so shared links preview nicely.
- If you set an `ANALYTICS_SNIPPET`, it is injected into every published page.
- Published markdown/text pages are self-styled with a minimal inline stylesheet by default; set `PUBLISH_CSS_URL` to skin them with your own stylesheet instead.

## Prerequisites

- A VPS running **Caddy** (2.6+)
- **Node.js** 18+
- A domain with DNS you control

## Setup

### 1. Clone and install

```bash
git clone https://github.com/RobbyMcCullough/honeydrop.git
cd honeydrop
npm install --omit=dev
```

### 2. Create the shared directory

This is where published documents are written. It should be outside the honeydrop repo so it is never accidentally overwritten by a git pull.

```bash
mkdir -p /var/www/your-shared-dir
```

### 3. Configure Caddy

Copy `Caddyfile.example` and adapt it to your domain. Generate a password hash:

```bash
caddy hash-password --plaintext 'your-password'
```

Add the output to the `basicauth` block. See `Caddyfile.example` for both subdomain and path-based options.

Reload Caddy after editing:

```bash
sudo systemctl reload caddy
```

### 4. Set up the systemd service

Copy `honeydrop.service` to `/etc/systemd/system/`, edit the paths and environment variables, then enable it:

```bash
sudo cp honeydrop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now honeydrop
```

### 5. DNS

Point your upload subdomain at your server's IP. Use DNS-only mode (no proxy) if using Cloudflare so Caddy can provision the TLS certificate directly.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SHARED_DIR` | yes | `./shared` | Absolute path where published files are written |
| `BASE_URL` | yes | `http://localhost:3001/s` | Public URL prefix for published documents |
| `SITE_URL` | no | — | Main site URL, used for favicon `<link>` tags in the upload UI |
| `ANALYTICS_SNIPPET` | no | — | HTML snippet injected into every published page (e.g. Plausible or Fathom script tag) |
| `PORT` | no | `3001` | Port the server listens on |
| `HOST` | no | `127.0.0.1` | Host the server binds to |
| `MAX_BYTES` | no | `10485760` | Max size per file in bytes (default 10 MB) |
| `MAX_FILES` | no | `20` | Max number of files per upload (the document plus its images) |
| `SITE_NAME` | no | — | `og:site_name` on published pages (e.g. `example.com`) |
| `PUBLISH_CSS_URL` | no | — | External stylesheet URL for published pages; falls back to a minimal inline style if unset |
| `OG_DEFAULT_IMAGE` | no | — | Fallback `og:image` when the document references no image |
| `OG_DEFAULT_DESCRIPTION` | no | — | Fallback description when none can be derived from the document |
| `LOG_LEVEL` | no | `info` | Fastify log level |

## Security

- Caddy `basicauth` gates the upload UI before any request reaches the server.
- Each upload must contain exactly one document (`.html`, `.htm`, `.md`, or `.txt`). Alongside it you may include image assets (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.avif`, `.ico`, `.bmp`). Anything else is rejected.
- Asset filenames are reduced to their base name before writing, so a malicious `../` filename can never escape the published folder.
- Slugs are sanitized to `[a-z0-9-]` and capped at 80 characters. Caller-controlled paths are not possible.
- Files are written with `flag: 'wx'` — existing slugs are never silently overwritten. A suffix is appended instead (`slug-1`, `slug-2`, …).
- The server binds to `127.0.0.1` by default and should never be exposed directly to the internet.
- Keep your shared directory separate from the app directory so a `git pull` can never affect published documents.

## License

MIT
