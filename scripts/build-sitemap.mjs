#!/usr/bin/env node
// site/ 以下の index.html を走査して site/sitemap.xml と site/robots.txt を生成する。
// ベースURLは site/config.js の CONFIG.siteUrl。
// あわせて site/tools/ 配下のページの canonical / og:url / og:image / JSON-LD のホスト部分を CONFIG.siteUrl に合わせる。
// 使い方: node scripts/build-sitemap.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const { CONFIG } = await import(pathToFileURL(join(siteDir, 'config.js')).href);
const base = String(CONFIG.siteUrl || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) throw new Error(`CONFIG.siteUrl が不正です: ${CONFIG.siteUrl}`);

// サイトマップに載せないディレクトリ（購入完了ページなど）
const EXCLUDE = [/^thanks\//, /^lib\//, /^assets\//, /^node_modules\//];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name === 'index.html') out.push({ file: p, mtime: st.mtime });
  }
  return out;
}

const pages = walk(siteDir)
  .map(({ file, mtime }) => {
    const rel = relative(siteDir, dirname(file)).split(sep).join('/');
    return { file, path: rel ? `${rel}/` : '', mtime };
  })
  .filter((p) => !EXCLUDE.some((re) => re.test(p.path)))
  .filter((p) => !/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(readFileSync(p.file, 'utf8')))
  .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));

// canonical / og:url / og:image / JSON-LD のホストを CONFIG.siteUrl に揃える（tools 配下のみ）
let rewritten = 0;
for (const p of pages) {
  if (!p.path.startsWith('tools/')) continue;
  const html = readFileSync(p.file, 'utf8');
  const next = html
    .replace(/(<link rel="canonical" href=")https?:\/\/[^/"]+/g, `$1${base}`)
    .replace(/(<meta property="og:url" content=")https?:\/\/[^/"]+/g, `$1${base}`)
    .replace(/(<meta property="og:image" content=")https?:\/\/[^/"]+/g, `$1${base}`)
    .replace(/("(?:url|item)":")https?:\/\/[^/"]+/g, `$1${base}`);
  if (next !== html) { writeFileSync(p.file, next); rewritten++; }
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const urls = pages.map((p) => {
  const loc = `${base}/${p.path}`;
  const lastmod = p.mtime.toISOString().slice(0, 10);
  return `  <url>\n    <loc>${xmlEsc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
});
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
writeFileSync(join(siteDir, 'sitemap.xml'), xml);

const robots = `User-agent: *\nAllow: /\nDisallow: /thanks/\n\nSitemap: ${base}/sitemap.xml\n`;
writeFileSync(join(siteDir, 'robots.txt'), robots);

console.log(`sitemap.xml: ${pages.length} URLs (${base})`);
for (const p of pages) console.log(`  /${p.path}`);
if (rewritten) console.log(`canonical/og:url を更新: ${rewritten} files`);
