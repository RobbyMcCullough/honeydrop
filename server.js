import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { writeFile, mkdir, access, readdir, stat, rm } from 'fs/promises'
import { join, extname, resolve, basename, sep } from 'path'
import { marked } from 'marked'
import { randomBytes } from 'crypto'
import { extractFrontmatter, metadataFromMarkdown, metadataFromHtml, mergeMetadata, injectMetadata } from './upload-meta.mjs'

// ── Configuration (via environment variables) ──────────────────────────────
const SHARED_DIR  = resolve(process.env.SHARED_DIR  || './shared')
const BASE_URL    = (process.env.BASE_URL  || 'http://localhost:3001/s').replace(/\/$/, '')
const SITE_URL    = (process.env.SITE_URL  || '').replace(/\/$/, '')
const ANALYTICS   = process.env.ANALYTICS_SNIPPET || ''
const PUBLISH_CSS = process.env.PUBLISH_CSS_URL || ''  // external stylesheet for published pages; inline styles if unset
const PORT        = parseInt(process.env.PORT || '3001', 10)
const HOST        = process.env.HOST || '127.0.0.1'
const MAX_BYTES   = parseInt(process.env.MAX_BYTES || String(10 * 1024 * 1024), 10)

// The single document that becomes the published page.
const DOC_ALLOWED   = new Set(['.html', '.htm', '.md', '.txt'])
// Sibling assets written alongside it, so relative <img src> just resolves.
const ASSET_ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp'])
const MAX_FILES     = parseInt(process.env.MAX_FILES || '20', 10)

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } })

fastify.register(multipart, {
  limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 4 }
})

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(filename) {
  const base = filename.replace(/\.[^.]+$/, '')
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || randomBytes(4).toString('hex')
}

function sanitizeSlug(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

async function uniqueSlug(base) {
  let slug = base
  let i = 1
  while (true) {
    try {
      await access(join(SHARED_DIR, slug))
      slug = `${base}-${i++}`
    } catch {
      return slug
    }
  }
}

// Reduce an uploaded asset's filename to a safe, flat name that cannot escape
// the slug directory. Returns null if the name is unusable or would collide
// with the generated page.
function safeAssetName(filename) {
  const name = basename(filename || '').trim()
  if (!name || name === '.' || name === '..') return null
  if (name.includes('\0')) return null
  if (name.toLowerCase() === 'index.html') return null
  if (name.length > 120) return null
  return name
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PUBLISH_CSS_TAG = PUBLISH_CSS ? `<link rel="stylesheet" href="${PUBLISH_CSS}">` : ''

// True if the HTML already carries embedded or linked stylesheets.
function hasOwnStyling(html) {
  return /<style[\s>]/i.test(html) || /<link[^>]+rel=["']stylesheet["']/i.test(html)
}

// Inject one or more tags before </head>, or prepend if there is no <head>.
function injectIntoHead(html, ...tags) {
  const snippet = tags.filter(Boolean).join('\n  ')
  if (!snippet) return html
  if (html.includes('</head>')) {
    return html.replace('</head>', `  ${snippet}\n</head>`)
  }
  return `${snippet}\n${html}`
}

// Styling for wrapped markdown/text pages: an external stylesheet if
// PUBLISH_CSS_URL is configured, otherwise a self-contained inline block.
const DEFAULT_STYLE = `<style>
    body{max-width:720px;margin:2rem auto;padding:0 1.25rem;font-family:system-ui,sans-serif;line-height:1.65;color:#1a1a1a}
    a{color:#0066cc}
    pre,code{font-family:monospace;font-size:.9em}
    pre{background:#f5f5f5;padding:1rem;overflow-x:auto;border-radius:4px}
    img{max-width:100%}
    h1,h2,h3{line-height:1.25}
    blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1rem;color:#666}
  </style>`

function wrapTemplate(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${ANALYTICS}
  ${PUBLISH_CSS_TAG || DEFAULT_STYLE}
</head>
<body>
${body}
</body>
</html>`
}

// ── Upload UI ──────────────────────────────────────────────────────────────

const HEX_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='100'%3E%3Cpath d='M28 66L0 50V16L28 0l28 16v34L28 66zm0 34L0 84V66l28 16 28-16v18L28 100z' fill='none' stroke='%23c87814' stroke-width='0.75' stroke-opacity='0.18'/%3E%3C/svg%3E")`

const faviconTags = SITE_URL ? `
  <link rel="icon" href="${SITE_URL}/favicon.ico" sizes="32x32">
  <link rel="icon" href="${SITE_URL}/favicon.png" type="image/png">
  <link rel="apple-touch-icon" href="${SITE_URL}/assets/apple-touch-icon.png">` : ''

const UI = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>honeydrop</title>${faviconTags}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

    body {
      min-height: 100vh;
      background-color: #0d0900;
      background-image: ${HEX_BG};
      color: #f0deb0;
      font-family: system-ui, sans-serif;
      display: flex;
      justify-content: center;
      padding: 3rem 1rem 4rem;
    }

    .page { width: 100%; max-width: 540px; }

    h1 {
      font-size: .85rem;
      font-weight: 400;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: #c87814;
      margin-bottom: 2rem;
    }

    .card {
      background: #150c00;
      border: 1px solid rgba(200, 130, 20, 0.28);
      border-radius: 10px;
      padding: 1.5rem;
    }

    .drop {
      border: 1px dashed rgba(200, 130, 20, 0.35);
      border-radius: 8px;
      padding: 2.25rem 1.5rem;
      text-align: center;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      position: relative;
    }
    .drop:hover, .drop.over { border-color: #e8920a; background: rgba(200, 130, 20, 0.06); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
    .drop-label strong { display: block; margin-bottom: .3rem; color: #f0deb0; font-weight: 500; }
    .drop-label .hint { font-size: .8rem; color: #7a5a20; }
    .chosen { margin-top: .6rem; font-size: .82rem; color: #a07030; min-height: 1.1em; font-family: monospace; }

    .field { margin-top: 1rem; }
    .field label { display: block; font-size: .78rem; color: #7a5a20; margin-bottom: .35rem; }
    .field input {
      width: 100%;
      background: #0d0900;
      border: 1px solid rgba(200, 130, 20, 0.25);
      border-radius: 6px;
      padding: .5rem .75rem;
      color: #f0deb0;
      font-size: .88rem;
      font-family: monospace;
    }
    .field input::placeholder { color: #3d2800; }
    .field input:focus { outline: none; border-color: #c87814; }

    .publish-btn {
      margin-top: 1.25rem;
      width: 100%;
      padding: .7rem;
      background: #e8920a;
      color: #0d0900;
      border: none;
      border-radius: 6px;
      font-size: .9rem;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: .03em;
      transition: opacity .15s;
    }
    .publish-btn:hover { opacity: .88; }
    .publish-btn:disabled { opacity: .3; cursor: default; }

    .flash {
      margin-top: .9rem;
      padding: .75rem 1rem;
      border-radius: 7px;
      font-size: .85rem;
      display: none;
    }
    .flash.ok   { background: rgba(80, 180, 60, 0.1);  border: 1px solid rgba(80, 180, 60, 0.3);  }
    .flash.err  { background: rgba(200, 60, 60, 0.1);  border: 1px solid rgba(200, 60, 60, 0.3);  }
    .flash.warn { background: rgba(200, 130, 20, 0.1); border: 1px solid rgba(200, 130, 20, 0.35); }
    .flash-url { font-family: monospace; word-break: break-all; }

    .conflict-msg { font-family: system-ui, sans-serif; margin-bottom: .65rem; color: #f0deb0; }
    .conflict-msg strong { color: #e8b060; font-family: monospace; }
    .conflict-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .conflict-btn {
      flex: 1; min-width: 130px;
      padding: .5rem .75rem;
      border-radius: 6px;
      font-size: .82rem; font-weight: 600;
      cursor: pointer;
      border: 1px solid rgba(200, 130, 20, 0.35);
      background: #0d0900; color: #f0deb0;
      transition: opacity .15s, background .15s;
    }
    .conflict-btn:hover { background: rgba(200, 130, 20, 0.12); }
    .conflict-btn.primary { background: #e8920a; color: #0d0900; border-color: #e8920a; }
    .conflict-btn.primary:hover { opacity: .88; }
    .flash-url a { color: #e8b060; text-decoration: none; }
    .flash-url a:hover { text-decoration: underline; }
    .inline-copy {
      margin-top: .5rem;
      background: rgba(200, 130, 20, 0.12);
      border: 1px solid rgba(200, 130, 20, 0.3);
      color: #c87814;
      border-radius: 4px;
      padding: .25rem .65rem;
      font-size: .78rem;
      cursor: pointer;
    }
    .inline-copy:hover { background: rgba(200, 130, 20, 0.22); }
    .err-msg { color: #f08888; }

    .section-head {
      display: flex;
      align-items: center;
      gap: .75rem;
      margin: 2rem 0 .85rem;
    }
    .section-head h2 {
      font-size: .78rem;
      font-weight: 500;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: #7a5a20;
      white-space: nowrap;
    }
    .section-head hr { flex: 1; border: none; border-top: 1px solid rgba(200, 130, 20, 0.18); }

    .file-list { display: flex; flex-direction: column; gap: .4rem; }

    .file-row {
      display: flex;
      align-items: center;
      gap: .5rem;
      background: #150c00;
      border: 1px solid rgba(200, 130, 20, 0.18);
      border-radius: 7px;
      padding: .6rem .85rem;
      transition: border-color .12s;
    }
    .file-row:hover { border-color: rgba(200, 130, 20, 0.38); }
    .file-url {
      flex: 1;
      font-family: monospace;
      font-size: .8rem;
      color: #e8b060;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-url:hover { text-decoration: underline; }
    .file-date { font-size: .72rem; color: #4a3010; white-space: nowrap; }
    .icon-btn {
      flex-shrink: 0;
      background: none;
      border: none;
      cursor: pointer;
      padding: .25rem;
      color: #5a4010;
      border-radius: 4px;
      display: flex;
      align-items: center;
      transition: color .12s, background .12s;
    }
    .icon-btn:hover { background: rgba(200, 130, 20, 0.12); }
    .icon-btn.copy-icon:hover { color: #c87814; }
    .icon-btn.del-icon:hover { color: #d04040; background: rgba(200, 60, 60, 0.1); }
    .empty-state { font-size: .82rem; color: #3d2800; text-align: center; padding: 1.5rem; }
  </style>
</head>
<body>
  <div class="page">
    <h1>honeydrop</h1>

    <div class="card">
      <form id="form">
        <div class="drop" id="drop">
          <input type="file" id="file" multiple accept=".html,.htm,.md,.txt,.png,.jpg,.jpeg,.gif,.svg,.webp,.avif,.ico,.bmp,image/*">
          <div class="drop-label">
            <strong>Drop files or click to browse</strong>
            <span class="hint">one .html &middot; .md &middot; .txt, plus any images it references</span>
          </div>
        </div>
        <div class="chosen" id="chosen"></div>
        <div class="field">
          <label for="slug">Slug <span style="opacity:.45">(optional — defaults to filename)</span></label>
          <input type="text" id="slug" name="slug" placeholder="my-document" autocomplete="off" spellcheck="false">
        </div>
        <button class="publish-btn" type="submit" id="btn" disabled>Publish</button>
      </form>
      <div class="flash" id="flash">
        <div class="flash-url" id="flash-url"></div>
        <button class="inline-copy" id="inline-copy" style="display:none">Copy URL</button>
      </div>
    </div>

    <div class="section-head">
      <h2>Published</h2>
      <hr>
    </div>
    <div class="file-list" id="file-list">
      <div class="empty-state">Loading…</div>
    </div>
  </div>

  <script>
    const drop       = document.getElementById('drop')
    const fileInput  = document.getElementById('file')
    const chosen     = document.getElementById('chosen')
    const slugInput  = document.getElementById('slug')
    const btn        = document.getElementById('btn')
    const form       = document.getElementById('form')
    const flash      = document.getElementById('flash')
    const flashUrl   = document.getElementById('flash-url')
    const inlineCopy = document.getElementById('inline-copy')
    const fileList   = document.getElementById('file-list')
    let selectedFiles = []

    const DOC_RE = /\\.(html?|md|txt)$/i

    const ICON_COPY  = \`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>\`
    const ICON_TRASH = \`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>\`

    function fmtDate(iso) {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }

    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const prev = btn.innerHTML
        btn.innerHTML = 'Copied!'
        btn.style.fontSize = '.75rem'
        setTimeout(() => { btn.innerHTML = prev; btn.style.fontSize = '' }, 1400)
      })
    }

    function buildRow(f) {
      const row = document.createElement('div')
      row.className = 'file-row'
      row.dataset.slug = f.slug

      const link = document.createElement('a')
      link.href = f.url
      link.target = '_blank'
      link.className = 'file-url'
      link.textContent = f.url

      const date = document.createElement('span')
      date.className = 'file-date'
      date.textContent = fmtDate(f.uploadedAt)

      const cp = document.createElement('button')
      cp.className = 'icon-btn copy-icon'
      cp.title = 'Copy URL'
      cp.innerHTML = ICON_COPY
      cp.addEventListener('click', () => copyText(f.url, cp))

      const del = document.createElement('button')
      del.className = 'icon-btn del-icon'
      del.title = 'Delete'
      del.innerHTML = ICON_TRASH
      del.addEventListener('click', async () => {
        if (!confirm('Delete ' + f.slug + '?')) return
        try {
          const r = await fetch('/files/' + f.slug, { method: 'DELETE' })
          const d = await r.json()
          if (d.ok) {
            row.remove()
            if (!fileList.querySelector('.file-row')) {
              fileList.innerHTML = '<div class="empty-state">No files yet.</div>'
            }
          }
        } catch { /* leave row on network error */ }
      })

      row.append(link, date, cp, del)
      return row
    }

    async function loadFiles() {
      try {
        const res = await fetch('/files')
        const files = await res.json()
        fileList.innerHTML = ''
        if (!files.length) {
          fileList.innerHTML = '<div class="empty-state">No files yet.</div>'
          return
        }
        files.forEach(f => fileList.appendChild(buildRow(f)))
      } catch {
        fileList.innerHTML = '<div class="empty-state">Could not load files.</div>'
      }
    }

    function onFiles(list) {
      const files = Array.from(list || [])
      if (!files.length) return
      selectedFiles = files

      const docs = files.filter(f => DOC_RE.test(f.name))
      const assets = files.filter(f => !DOC_RE.test(f.name))

      if (docs.length !== 1) {
        chosen.innerHTML = '<span style="color:#f08888">Select exactly one .md/.html/.txt document (plus any images).</span>'
        btn.disabled = true
        return
      }

      const parts = [docs[0].name]
      if (assets.length) parts.push('+ ' + assets.length + ' image' + (assets.length === 1 ? '' : 's'))
      chosen.textContent = parts.join('  ')

      if (!slugInput.value) {
        slugInput.placeholder = docs[0].name.replace(/\\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      }
      btn.disabled = false
    }

    fileInput.addEventListener('change', () => onFiles(fileInput.files))
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); onFiles(e.dataTransfer.files) })

    // conflict: '' asks the server (409 → prompt), 'overwrite' replaces, 'rename' makes a new URL.
    async function doUpload(conflict) {
      if (!selectedFiles.length) return
      btn.disabled = true
      btn.textContent = 'Publishing…'
      flash.style.display = 'none'
      inlineCopy.style.display = 'none'

      const fd = new FormData()
      selectedFiles.forEach(f => fd.append('file', f))
      if (slugInput.value.trim()) fd.append('slug', slugInput.value.trim())
      if (conflict) fd.append('conflict', conflict)

      try {
        const res = await fetch('/upload', { method: 'POST', body: fd })
        const data = await res.json()
        flash.style.display = 'block'
        if (data.ok) {
          flash.className = 'flash ok'
          const note = data.assets ? ' <span style="color:#7a5a20">(' + data.assets + ' image' + (data.assets === 1 ? '' : 's') + ')</span>' : ''
          flashUrl.innerHTML = '<a href="' + data.url + '" target="_blank">' + data.url + '</a>' + note
          inlineCopy.style.display = 'inline-block'
          inlineCopy.onclick = () => copyText(data.url, inlineCopy)
          loadFiles()
        } else if (res.status === 409 && data.conflict) {
          flash.className = 'flash warn'
          flashUrl.innerHTML =
            '<div class="conflict-msg"><strong>' + data.slug + '</strong> already exists. Replace it, or publish as a new URL?</div>' +
            '<div class="conflict-actions">' +
              '<button type="button" class="conflict-btn primary" id="cf-overwrite">Overwrite</button>' +
              '<button type="button" class="conflict-btn" id="cf-keep">Keep both (new URL)</button>' +
            '</div>'
          document.getElementById('cf-overwrite').onclick = () => doUpload('overwrite')
          document.getElementById('cf-keep').onclick = () => doUpload('rename')
        } else {
          flash.className = 'flash err'
          flashUrl.innerHTML = '<span class="err-msg">' + (data.error || 'Upload failed') + '</span>'
        }
      } catch {
        flash.style.display = 'block'
        flash.className = 'flash err'
        flashUrl.innerHTML = '<span class="err-msg">Network error</span>'
      }

      btn.disabled = false
      btn.textContent = 'Publish'
    }

    form.addEventListener('submit', e => { e.preventDefault(); doUpload('') })

    loadFiles()
  </script>
</body>
</html>`

// ── Routes ─────────────────────────────────────────────────────────────────

fastify.get('/', async (req, reply) => {
  return reply.type('text/html').send(UI)
})

fastify.get('/files', async () => {
  let entries
  try {
    entries = await readdir(SHARED_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const files = await Promise.all(
    entries
      .filter(e => e.isDirectory())
      .map(async e => {
        try {
          const s = await stat(join(SHARED_DIR, e.name, 'index.html'))
          return { slug: e.name, url: `${BASE_URL}/${e.name}/`, uploadedAt: s.mtime.toISOString() }
        } catch {
          return null
        }
      })
  )
  return files
    .filter(Boolean)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
})

fastify.delete('/files/:slug', async (req, reply) => {
  const raw = req.params.slug
  const slug = sanitizeSlug(raw)
  if (!slug || slug !== raw) return reply.code(400).send({ ok: false, error: 'Invalid slug' })

  const dir = join(SHARED_DIR, slug)
  try {
    await access(dir)
  } catch {
    return reply.code(404).send({ ok: false, error: 'Not found' })
  }

  await rm(dir, { recursive: true, force: true })
  fastify.log.info({ event: 'delete', slug })
  return { ok: true }
})

fastify.post('/upload', async (req, reply) => {
  const parts = req.parts()
  const files = []
  let customSlug = null
  let onConflict = ''  // '' = ask (409), 'overwrite' = replace, 'rename' = auto-suffix

  // Buffer every part before responding — an unconsumed part stalls the stream.
  for await (const part of parts) {
    if (part.type === 'file') {
      files.push({ filename: part.filename, ext: extname(part.filename).toLowerCase(), buffer: await part.toBuffer() })
    } else if (part.fieldname === 'slug' && part.value?.trim()) {
      customSlug = part.value.trim()
    } else if (part.fieldname === 'conflict' && part.value) {
      onConflict = part.value
    }
  }

  if (!files.length) return reply.code(400).send({ ok: false, error: 'No file received' })

  const oversized = files.find(f => f.buffer.length > MAX_BYTES)
  if (oversized) {
    return reply.code(413).send({ ok: false, error: `"${oversized.filename}" too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB per file)` })
  }

  const unknown = files.find(f => !DOC_ALLOWED.has(f.ext) && !ASSET_ALLOWED.has(f.ext))
  if (unknown) {
    return reply.code(400).send({ ok: false, error: `"${unknown.ext}" not allowed. Documents: .html .htm .md .txt — images: ${[...ASSET_ALLOWED].join(' ')}` })
  }

  const docs = files.filter(f => DOC_ALLOWED.has(f.ext))
  const assets = files.filter(f => ASSET_ALLOWED.has(f.ext))

  if (docs.length === 0) return reply.code(400).send({ ok: false, error: 'No document found. Include one .md, .html, or .txt file.' })
  if (docs.length > 1) return reply.code(400).send({ ok: false, error: 'Include exactly one document (.md/.html/.txt); the other files should be images.' })

  const doc = docs[0]
  const baseSlug = customSlug ? sanitizeSlug(customSlug) : slugify(doc.filename)
  if (!baseSlug) return reply.code(400).send({ ok: false, error: 'Could not derive a valid slug from the filename' })

  // Resolve every asset name up front so we can reject the whole upload before
  // writing anything, rather than leaving a half-published folder behind.
  const namedAssets = []
  for (const a of assets) {
    const name = safeAssetName(a.filename)
    if (!name) return reply.code(400).send({ ok: false, error: `Unsafe asset filename: "${a.filename}"` })
    namedAssets.push({ name, buffer: a.buffer })
  }

  // Resolve the slug, honoring how the caller wants naming conflicts handled.
  let slugExists = false
  try { await access(join(SHARED_DIR, baseSlug)); slugExists = true } catch {}

  let slug
  if (slugExists && onConflict === 'overwrite') {
    await rm(join(SHARED_DIR, baseSlug), { recursive: true, force: true })
    slug = baseSlug
  } else if (slugExists && onConflict === 'rename') {
    slug = await uniqueSlug(baseSlug)
  } else if (slugExists) {
    // Default: don't guess — let the client prompt overwrite vs. new URL.
    return reply.code(409).send({ ok: false, conflict: true, slug: baseSlug, url: `${BASE_URL}/${baseSlug}/` })
  } else {
    slug = baseSlug
  }

  const content = doc.buffer.toString('utf8')
  const pageUrl = `${BASE_URL}/${slug}/`

  let html
  if (doc.ext === '.md') {
    const [, markdownBody] = extractFrontmatter(content)
    const metadata = mergeMetadata({ extracted: metadataFromMarkdown(content, doc.filename), url: pageUrl })
    html = injectMetadata(wrapTemplate(metadata.title, await marked.parse(markdownBody)), metadata)
  } else if (doc.ext === '.txt') {
    const title = baseSlug.replace(/-/g, ' ')
    const metadata = mergeMetadata({ extracted: { title }, url: pageUrl })
    html = injectMetadata(wrapTemplate(title, `<pre>${escapeHtml(content)}</pre>`), metadata)
  } else {
    // HTML served as-is, but injected with analytics (+ a default stylesheet
    // when the document carries none and PUBLISH_CSS_URL is set) and metadata.
    const cssTag = (PUBLISH_CSS && !hasOwnStyling(content)) ? PUBLISH_CSS_TAG : null
    const metadata = mergeMetadata({ extracted: metadataFromHtml(content, doc.filename), url: pageUrl })
    html = injectMetadata(injectIntoHead(content, cssTag, ANALYTICS), metadata)
  }

  const destDir = join(SHARED_DIR, slug)
  await mkdir(destDir, { recursive: true })
  await writeFile(join(destDir, 'index.html'), html, { flag: 'wx' })

  const dirPrefix = resolve(destDir) + sep
  for (const a of namedAssets) {
    const dest = join(destDir, a.name)
    // Belt-and-suspenders against traversal after safeAssetName.
    if (!resolve(dest).startsWith(dirPrefix)) continue
    await writeFile(dest, a.buffer, { flag: 'wx' })
  }

  const url = `${BASE_URL}/${slug}/`
  fastify.log.info({ event: 'upload', slug, filename: doc.filename, bytes: doc.buffer.length, assets: namedAssets.length })

  return { ok: true, url, assets: namedAssets.length }
})

// ── Start ──────────────────────────────────────────────────────────────────

await mkdir(SHARED_DIR, { recursive: true })

fastify.listen({ port: PORT, host: HOST }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1) }
})
