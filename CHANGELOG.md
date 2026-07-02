# Changelog

All notable changes to honeydrop are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-07-02

### Added
- Naming-conflict handling on upload. When the target slug already exists the
  server responds `409` and the UI prompts to **overwrite** the existing
  document or **keep both** (publish at a suffixed URL). Previously a suffix was
  always appended silently. Overwrite replaces the entire published folder, so
  stale assets from the prior version are cleaned up. Controlled by a new
  optional `conflict` form field (`overwrite` | `rename`).

## [1.1.0] - 2026-07-02

### Added
- Upload a document together with the image assets it references. Sibling images
  are written into the same published folder, so relative links like
  `![](diagram.png)` resolve without any rewriting. The UI accepts multiple files;
  `MAX_FILES` (default 20) caps the count.
- Open Graph / Twitter Card metadata on every published page (`upload-meta.mjs`):
  title, description, canonical URL, and an `og:image` derived from the document's
  first image or `OG_DEFAULT_IMAGE`.
- `PUBLISH_CSS_URL` to skin published pages with an external stylesheet instead of
  the built-in inline styles; a default stylesheet is injected into style-less HTML
  uploads when set.
- New env vars: `MAX_FILES`, `SITE_NAME`, `PUBLISH_CSS_URL`, `OG_DEFAULT_IMAGE`,
  `OG_DEFAULT_DESCRIPTION`.

### Security
- Uploaded asset filenames are reduced to their base name and validated before any
  write, so a crafted `../` filename cannot escape the published folder.

## [1.0.0] - 2026-05-13

### Added
- Initial release: single-file upload service publishing HTML/Markdown/text
  documents at clean `/s/<slug>/` URLs behind Caddy basic auth.
