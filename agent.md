# honeydrop — Agent Deployment Brief

This document is written for an AI agent. It covers everything needed to deploy honeydrop from scratch on a fresh Ubuntu server running Caddy. Follow the steps in order. Verify each step before proceeding.

## What you are building

honeydrop is a private upload service. The owner drops an HTML or Markdown file into a drag-and-drop UI, and it is published immediately at a clean public URL. The public site stays static. The upload surface is authenticated. The backend is a small Node.js app that Caddy reverse-proxies to.

```
upload.yourdomain.com   →  Caddy basic auth  →  honeydrop (127.0.0.1:3001)
yourdomain.com/s/<slug>  →  Caddy file_server  →  /path/to/shared/<slug>/index.html
```

## Prerequisites

Before starting, confirm:

- Ubuntu server (20.04 or 24.04) with a non-root deploy user that owns `/var/www/`
- Caddy 2.6+ installed and running (`systemctl is-active caddy`)
- Node.js 18+ installed (`node --version`)
- A domain with Cloudflare DNS (or equivalent)
- SSH access as the deploy user

## Variables

Replace these throughout the steps below:

| Placeholder | Example |
|---|---|
| `DOMAIN` | `yourdomain.com` |
| `UPLOAD_SUBDOMAIN` | `upload.yourdomain.com` |
| `SERVER_IP` | `203.0.113.10` |
| `DEPLOY_USER` | `deploy` |
| `APP_DIR` | `/var/www/honeydrop` |
| `SHARED_DIR` | `/var/www/honeydrop-shared` |
| `UPLOAD_USERNAME` | `robby` |
| `UPLOAD_PASSWORD` | *(generate a strong random password)* |

## Steps

### 1. Create directories

```bash
mkdir -p APP_DIR SHARED_DIR
```

Verify: `ls /var/www/` should show both directories.

### 2. Clone honeydrop

```bash
git clone https://github.com/RobbyMcCullough/honeydrop.git APP_DIR
cd APP_DIR
npm install --omit=dev
```

Verify: `ls APP_DIR/node_modules` should be non-empty.

### 3. Smoke-test the server

```bash
SHARED_DIR=SHARED_DIR BASE_URL=https://DOMAIN/s node APP_DIR/server.js &
sleep 2
curl -s http://127.0.0.1:3001/ | grep -o '<title>[^<]*</title>'
kill %1
```

Expected output: `<title>honeydrop</title>`

If this fails, check Node version and that dependencies installed correctly.

### 4. Generate a password hash

```bash
caddy hash-password --plaintext 'UPLOAD_PASSWORD'
```

Save the output — it looks like `$2a$14$...`. You will need it in step 6.

If `caddy hash-password` is not available without sudo, run it as root or check the installed Caddy version. On some builds the directive is `basicauth` (no underscore) rather than `basic_auth` — test with `caddy validate` if you encounter errors.

### 5. Update the Caddyfile

Read the current Caddyfile (`/etc/caddy/Caddyfile`) and add two blocks.

**Block 1 — update or add the main domain:**

```caddyfile
DOMAIN, www.DOMAIN {
    handle_path /s/* {
        root * SHARED_DIR
        file_server
    }

    handle {
        root * /path/to/your/public/site
        file_server
    }
}
```

**Block 2 — add the upload subdomain:**

```caddyfile
UPLOAD_SUBDOMAIN {
    basicauth {
        UPLOAD_USERNAME HASHED_PASSWORD
    }

    request_body {
        max_size 10MB
    }

    reverse_proxy 127.0.0.1:3001
}
```

Validate before reloading:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Reload:

```bash
sudo systemctl reload caddy
```

Verify Caddy is still active: `systemctl is-active caddy`

### 6. Install the systemd service

Copy and edit the service file:

```bash
cp APP_DIR/honeydrop.service /tmp/honeydrop.service
```

Edit `/tmp/honeydrop.service` — set:
- `User=DEPLOY_USER`
- `WorkingDirectory=APP_DIR`
- `Environment=SHARED_DIR=SHARED_DIR`
- `Environment=BASE_URL=https://DOMAIN/s`
- `Environment=SITE_URL=https://DOMAIN` (optional, enables favicon on upload UI)
- `Environment=ANALYTICS_SNIPPET=` (optional, paste your analytics script tag here)

Install and start:

```bash
sudo cp /tmp/honeydrop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now honeydrop
```

Verify: `systemctl is-active honeydrop` should return `active`.

Check logs: `journalctl -u honeydrop -n 20 --no-pager`

The log should show: `Server listening at http://127.0.0.1:3001`

### 7. Add DNS records

Add two A records in Cloudflare (or your DNS provider):

| Name | Type | Value | Proxy |
|---|---|---|---|
| `@` | A | `SERVER_IP` | DNS only (grey cloud) |
| `upload` | A | `SERVER_IP` | DNS only (grey cloud) |

Use DNS-only mode so Caddy can obtain TLS certificates via Let's Encrypt directly.

Verify propagation: `dig +short UPLOAD_SUBDOMAIN` should return `SERVER_IP`.

### 8. Verify TLS

Wait 1–3 minutes after DNS propagates, then:

```bash
curl -sI https://UPLOAD_SUBDOMAIN
```

Expected: `HTTP/2 401` with `www-authenticate: Basic realm="restricted"`

If you see an SSL error instead of a 401, Caddy is still provisioning the certificate. Wait and retry.

### 9. End-to-end test

```bash
# Test authenticated access
curl -su "UPLOAD_USERNAME:UPLOAD_PASSWORD" https://UPLOAD_SUBDOMAIN | grep '<title>'

# Test upload
echo "# Hello" | curl -su "UPLOAD_USERNAME:UPLOAD_PASSWORD" \
  -F "file=@-;filename=hello.md" \
  https://UPLOAD_SUBDOMAIN/upload
```

Expected upload response: `{"ok":true,"url":"https://DOMAIN/s/hello/"}`

```bash
# Test published page is live
curl -s https://DOMAIN/s/hello/ | grep '<h1>'
```

Expected: `<h1>Hello</h1>`

## Troubleshooting

**Caddy reload fails with "unrecognized directive: basic_auth"**
The installed Caddy build uses `basicauth` (no underscore). Replace `basic_auth` with `basicauth` in the Caddyfile.

**TLS "internal error" on the upload subdomain**
DNS has propagated but Caddy hasn't provisioned the certificate yet. Verify port 80 is reachable (`curl -I http://UPLOAD_SUBDOMAIN`) and wait 2–3 minutes.

**Upload returns 413**
The file exceeds `MAX_BYTES`. Increase the limit in the systemd service file and restart, or reduce the file size.

**honeydrop service fails to start**
Check `journalctl -u honeydrop -n 50 --no-pager` for the error. Common causes: wrong `WorkingDirectory`, Node not found at `/usr/bin/node`, or `SHARED_DIR` path doesn't exist.

**Published page not found at /s/<slug>/**
Confirm `SHARED_DIR` in the service file matches the `root` path in the Caddyfile `/s/*` block.

## Keeping the shared directory safe

The `SHARED_DIR` is not part of the honeydrop git repository and will not be affected by `git pull`. Do not place it inside `APP_DIR`. Back it up separately if the published documents matter.
