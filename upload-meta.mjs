#!/usr/bin/env node
//
// Metadata extraction + Open Graph / Twitter card injection for published pages.
//
// Importable (used by server.js) and runnable as a CLI. All site-specific
// defaults come from the environment so the same module works for any deploy:
//
//   SITE_NAME               og:site_name (e.g. "robb.ee"); omitted if unset
//   SITE_URL                root URL used to absolutize relative image paths
//   OG_DEFAULT_IMAGE        fallback og:image when the document has none
//   OG_DEFAULT_DESCRIPTION  fallback description when none can be derived
//
// When a value is absent (no title/description/image and no default), the
// corresponding tags are simply omitted rather than emitted empty.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_NAME           = process.env.SITE_NAME || "";
const BASE_URL            = (process.env.SITE_URL || "").replace(/\/$/, "");
const DEFAULT_TITLE       = SITE_NAME || "Untitled";
const DEFAULT_DESCRIPTION = process.env.OG_DEFAULT_DESCRIPTION || "";
const DEFAULT_IMAGE       = process.env.OG_DEFAULT_IMAGE || "";

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    options[key] = value;
    index += 1;
  }

  return options;
}

function usage() {
  return `Usage:
  node upload-meta.mjs --html rendered.html --out final.html --url https://example.com/s/article/
  node upload-meta.mjs --markdown article.md --html rendered.html --out final.html --url https://example.com/s/article/

Optional:
  --title "Custom title"
  --description "Custom description"
  --image /custom-og.png
  --base-url https://example.com`;
}

function stripHtml(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdown(value = "") {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateDescription(value, maxLength = 180) {
  const clean = value.replace(/\s+/g, " ").trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  const sliced = clean.slice(0, maxLength + 1);
  const boundary = sliced.lastIndexOf(" ");
  return `${sliced.slice(0, boundary > 120 ? boundary : maxLength).trim()}...`;
}

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return [{}, markdown];
  }

  const end = markdown.indexOf("\n---", 4);

  if (end === -1) {
    return [{}, markdown];
  }

  const raw = markdown.slice(4, end).trim();
  const body = markdown.slice(end + 4).replace(/^\s+/, "");
  const data = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, value] = match;
    data[key.trim()] = value.trim().replace(/^["']|["']$/g, "");
  }

  return [data, body];
}

function firstMarkdownParagraph(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "\n\n");
  const blocks = withoutCode.split(/\n\s*\n/);

  for (const block of blocks) {
    const clean = block.trim();

    if (
      !clean ||
      clean.startsWith("#") ||
      clean.startsWith("!") ||
      clean.startsWith("|") ||
      /^[-*+]\s/.test(clean) ||
      /^\d+\.\s/.test(clean)
    ) {
      continue;
    }

    return stripMarkdown(clean);
  }

  return "";
}

function titleFromFilename(filename = "") {
  const base = path.basename(filename, path.extname(filename));
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function metadataFromMarkdown(markdown, filename) {
  const [frontmatter, body] = extractFrontmatter(markdown);
  const h1 = body.match(/^#\s+(.+)$/m)?.[1];
  const image = body.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1];

  return compactMetadata({
    title: frontmatter.title || (h1 ? stripMarkdown(h1) : titleFromFilename(filename)),
    description: frontmatter.description || firstMarkdownParagraph(body),
    image: frontmatter.image || image
  });
}

function metadataFromHtml(html, filename) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metaDescription = html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const paragraph = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const image = html.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i)?.[1];

  return compactMetadata({
    title: stripHtml(title || h1 || titleFromFilename(filename)),
    description: stripHtml(metaDescription || paragraph || ""),
    image
  });
}

function compactMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function absoluteUrl(value, pageUrl, baseUrl = BASE_URL) {
  if (!value) {
    return "";
  }

  const base = pageUrl || baseUrl;
  if (!base) {
    return value; // no site root configured — leave the path as-is
  }
  return new URL(value, base).toString();
}

function mergeMetadata({ extracted = {}, overrides = {}, htmlPath = "", url = "", baseUrl = BASE_URL }) {
  const title = overrides.title || extracted.title || titleFromFilename(htmlPath) || DEFAULT_TITLE;
  const description = truncateDescription(overrides.description || extracted.description || DEFAULT_DESCRIPTION);
  const image = overrides.image || extracted.image || DEFAULT_IMAGE;
  const pageUrl = url || absoluteUrl(htmlPath ? `/${path.basename(htmlPath)}` : "/", baseUrl, baseUrl);

  return {
    title,
    description,
    image: absoluteUrl(image, pageUrl, baseUrl),
    url: absoluteUrl(pageUrl, baseUrl, baseUrl),
    siteName: SITE_NAME
  };
}

function metaTag(name, content, attr = "name") {
  return `<meta ${attr}="${name}" content="${escapeHtml(content)}">`;
}

function metadataBlock(metadata) {
  const lines = ["<!-- honeydrop upload metadata -->", `<title>${escapeHtml(metadata.title)}</title>`];

  if (metadata.description) {
    lines.push(metaTag("description", metadata.description));
  }
  if (metadata.url) {
    lines.push(`<link rel="canonical" href="${escapeHtml(metadata.url)}">`);
  }
  lines.push(metaTag("og:type", "article", "property"));
  if (metadata.siteName) {
    lines.push(metaTag("og:site_name", metadata.siteName, "property"));
  }
  lines.push(metaTag("og:title", metadata.title, "property"));
  if (metadata.description) {
    lines.push(metaTag("og:description", metadata.description, "property"));
  }
  if (metadata.url) {
    lines.push(metaTag("og:url", metadata.url, "property"));
  }
  if (metadata.image) {
    lines.push(metaTag("og:image", metadata.image, "property"));
    lines.push(metaTag("og:image:width", "1200", "property"));
    lines.push(metaTag("og:image:height", "630", "property"));
    lines.push(metaTag("twitter:card", "summary_large_image"));
  } else {
    lines.push(metaTag("twitter:card", "summary"));
  }
  lines.push(metaTag("twitter:title", metadata.title));
  if (metadata.description) {
    lines.push(metaTag("twitter:description", metadata.description));
  }
  if (metadata.image) {
    lines.push(metaTag("twitter:image", metadata.image));
  }
  lines.push("<!-- /honeydrop upload metadata -->");
  return lines.join("\n");
}

function removeExistingMetadata(html) {
  return html
    .replace(/<!-- honeydrop upload metadata -->[\s\S]*?<!-- \/honeydrop upload metadata -->\s*/i, "")
    .replace(/<title[^>]*>[\s\S]*?<\/title>\s*/gi, "")
    .replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>\s*/gi, "")
    .replace(/<meta\s+[^>]*(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+)["'][^>]*>\s*/gi, "");
}

function injectMetadata(html, metadata) {
  const clean = removeExistingMetadata(html);
  const block = metadataBlock(metadata);

  if (/<head[^>]*>/i.test(clean)) {
    return clean.replace(/<head[^>]*>/i, (match) => `${match}\n    ${block.replace(/\n/g, "\n    ")}\n`);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    ${block.replace(/\n/g, "\n    ")}
  </head>
  <body>
${clean}
  </body>
</html>`;
}

export {
  extractFrontmatter,
  metadataFromMarkdown,
  metadataFromHtml,
  mergeMetadata,
  injectMetadata
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.html || !options.out) {
    throw new Error(usage());
  }

  const html = await readFile(options.html, "utf8");
  const extracted = options.markdown
    ? metadataFromMarkdown(await readFile(options.markdown, "utf8"), options.markdown)
    : metadataFromHtml(html, options.html);
  const metadata = mergeMetadata({
    extracted,
    htmlPath: options.html,
    url: options.url,
    baseUrl: options["base-url"] || BASE_URL,
    overrides: {
      title: options.title,
      description: options.description,
      image: options.image
    }
  });

  await writeFile(options.out, injectMetadata(html, metadata), "utf8");
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
