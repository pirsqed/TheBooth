#!/usr/bin/env node
/**
 * Polite, resumable harvester for Public Domain National Park Service (NPS) sound collections:
 *   1. NPS Natural Sounds Gallery (https://www.nps.gov/subjects/sound/gallery.htm)
 *   2. Yellowstone National Park Sound Library (https://www.nps.gov/yell/learn/photosmultimedia/soundlibrary.htm)
 *   3. Internet Archive — Natural Sounds Field Recording Archive (lossless FLAC beds)
 *
 * Outputs clean category folders + a `catalog.json` sidecar compatible with
 * The Booth's `docs/asset-library-spec.md`.
 *
 * Usage:
 *   node scripts/harvest-nps-sounds.mjs --out "E:\AudioLibraries\NPS_NaturalSounds"
 *   node scripts/harvest-nps-sounds.mjs --out "E:\AudioLibraries\NPS_NaturalSounds" --dry-run
 *   node scripts/harvest-nps-sounds.mjs --out "E:\AudioLibraries\NPS_NaturalSounds" --skip-archive
 */

import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);

const USER_AGENT = 'TheBooth-NPS-AudioHarvester/1.0 (Public Domain Educational/Creative Library)';
const REQUEST_DELAY_MS = 250; // Polite pacing against nps.gov

function parseArgs(argv) {
  const opts = {
    outDir: 'E:\\AudioLibraries\\NPS_NaturalSounds',
    dryRun: false,
    skipGallery: false,
    skipYellowstone: false,
    skipArchive: false,
    archiveFormat: 'flac', // flac | wav | ogg | mp3
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) opts.outDir = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-gallery') opts.skipGallery = true;
    else if (a === '--skip-yellowstone') opts.skipYellowstone = true;
    else if (a === '--skip-archive') opts.skipArchive = true;
    else if (a === '--archive-format' && argv[i + 1]) opts.archiveFormat = argv[++i].toLowerCase();
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '—')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function slugifyFile(str) {
  return str
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function slugifyFolder(str) {
  return str
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-');
}

async function fetchText(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(750 * attempt);
    }
  }
}

async function downloadFile(url, destPath, expectedSize = null) {
  try {
    const st = await fs.stat(destPath);
    if (st.size > 0 && (!expectedSize || st.size === expectedSize)) {
      return { status: 'skipped', bytes: st.size };
    }
  } catch {
    // Does not exist yet
  }

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(600000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fssync.createWriteStream(tmpPath));
      const st = await fs.stat(tmpPath);
      if (st.size === 0) throw new Error('Downloaded 0 bytes');
      await fs.rename(tmpPath, destPath);
      return { status: 'downloaded', bytes: st.size };
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (attempt === 3) throw err;
      await sleep(1000 * attempt);
    }
  }
}

async function probeDurationSec(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const dur = parseFloat(stdout.trim());
    return Number.isFinite(dur) ? Math.round(dur * 100) / 100 : null;
  } catch {
    return null;
  }
}

function extractAudioUrls(html, baseUrl) {
  const found = new Set();
  const patterns = [
    /(?:src|href|data-[a-z0-9_-]+)\s*=\s*["']([^"']+\.(?:mp3|wav|ogg|flac|m4a)(?:\?[^"']*)?)["']/gi,
    /(https?:\/\/[^\s"'<>\\]+\.(?:mp3|wav|ogg|flac|m4a))/gi,
    /(\/nps-audiovideo\/[^\s"'<>\\]+\.(?:mp3|wav|ogg|flac|m4a))/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      let raw = m[1].replace(/\\\//g, '/').trim();
      try {
        const abs = new URL(raw, baseUrl).toString();
        found.add(abs);
      } catch {
        // ignore invalid URL
      }
    }
  }
  return [...found];
}

function extractPageMetadata(html) {
  const cleanedHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  const h1 = stripTags((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleanedHtml)?.[1] || ''));
  const title = h1.replace(/^Sound Gallery\s*[-–—:]\s*/i, '').trim();

  // Extract meaningful body paragraphs (skipping gov banner, spectrogram boilerplate, footer)
  const paras = [...cleanedHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((p) => {
      if (p.length < 20) return false;
      if (/Official websites? use \.gov|Official website of the United States|Secure \.gov websites|HTTPS|lock \(|nps\.gov|Download the NPS app|Experience Your America|PO Box \d+|Spectrograms are graphs that visualize sounds|Listen to more natural and human-made sounds|videojs\(|Homepage\s*\.VideoHero/i.test(p)) {
        return false;
      }
      return true;
    })
    .map((p) => p.replace(/^NPS Photo by [^.]+\.\s*/i, '').trim())
    .filter((p) => p.length >= 15);

  const description = paras.slice(0, 3).join(' ').slice(0, 600);
  return { title, description };
}

function humanizeAudioFilename(audioUrl) {
  const base = path.basename(new URL(audioUrl).pathname, path.extname(new URL(audioUrl).pathname));
  return base
    .replace(/^(?:nri|yell|imr|grte|glac|yose)[-_]+/i, '')
    .replace(/^YELL/i, '')
    .replace(/\d{6,8}(?:T\d+\w*)?/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTags(parts) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'national', 'park', 'sound', 'sounds', 'gallery', 'recording', 'audio', 'nps']);
  const set = new Set();
  for (const raw of parts) {
    if (!raw) continue;
    const words = raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    for (const w of words) {
      if (w.length >= 3 && !stop.has(w)) set.add(w);
    }
  }
  return [...set].slice(0, 16);
}

async function discoverNpsGallery() {
  const indexUrl = 'https://www.nps.gov/subjects/sound/gallery.htm';
  const html = await fetchText(indexUrl);
  const re = /<(h[234]|a)[^>]*>([\s\S]*?)<\/\1>/gi;
  const skipCats = new Set(['Tools', 'Sound Gallery', 'National Park Service']);
  const seenUrls = new Set();
  const pages = [];

  let m;
  let currentCat = 'Uncategorized';
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (tag.startsWith('h') && text) {
      if (!/Search|Menu|Navigation|Contact|Footer|Stay Connected/i.test(text)) {
        currentCat = text;
      }
    } else if (tag === 'a') {
      if (skipCats.has(currentCat)) continue;
      const hm = /href="([^"]+)"/i.exec(m[0]);
      if (!hm) continue;
      const href = hm[1];
      if (!/\/subjects\/sound\/[^"]+\.htm$/i.test(href)) continue;
      if (/gallery|index|measure|listen|soundscapes|natural|events|siteindex|contactus/i.test(href)) continue;
      const absUrl = new URL(href, indexUrl).toString();
      if (seenUrls.has(absUrl)) continue;
      seenUrls.add(absUrl);
      pages.push({ category: currentCat, label: text, pageUrl: absUrl });
    }
  }
  return pages;
}

async function discoverYellowstone() {
  const indexUrl = 'https://www.nps.gov/yell/learn/photosmultimedia/soundlibrary.htm';
  const html = await fetchText(indexUrl);
  const re = /<a[^>]*href="(\/yell\/learn\/photosmultimedia\/[^"]+\.htm)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set();
  const pages = [];

  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = stripTags(m[2]);
    if (/soundlibrary|videolibrary|photogallery|webcams|minute|voices|in-depth|virtual|podcasts|parktracks|acoustic/i.test(href)) {
      continue;
    }
    const absUrl = new URL(href, indexUrl).toString();
    if (seenUrls.has(absUrl)) continue;
    seenUrls.add(absUrl);
    pages.push({ category: 'Yellowstone', label: label || path.basename(href, '.htm'), pageUrl: absUrl });
  }
  return pages;
}

async function discoverArchiveOrg(format) {
  const metaUrl = 'https://archive.org/metadata/NaturalSoundsFieldRecordingArchive';
  const res = await fetch(metaUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Archive.org HTTP ${res.status}`);
  const meta = await res.json();
  const suffix = `.${format}`;
  return (meta.files || [])
    .filter((f) => typeof f.name === 'string' && f.name.toLowerCase().endsWith(suffix))
    .map((f) => ({
      name: f.name,
      size: Number(f.size || 0),
      lengthSec: f.length ? parseFloat(f.length) : null,
      url: `https://archive.org/download/NaturalSoundsFieldRecordingArchive/${encodeURIComponent(f.name)}`,
    }));
}

function describeArchiveFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const clean = base.replace(/^\d{8}/, '');
  const parts = clean.split('-').map((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').trim());
  if (parts.length >= 2) {
    return `${parts[0]} recorded at ${parts.slice(1).join(', ')} (NPS Natural Sounds Field Recording Archive).`;
  }
  return `${parts[0]} (NPS Natural Sounds Field Recording Archive).`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`NPS Sound Harvester -> ${opts.outDir}${opts.dryRun ? ' [DRY RUN]' : ''}`);

  const catalogPath = path.join(opts.outDir, 'catalog.json');
  let catalog = {};
  try {
    catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  } catch {
    catalog = {};
  }

  const stats = {
    discovered: 0,
    downloaded: 0,
    skipped: 0,
    noAudioPages: [],
    failed: [],
    totalBytes: 0,
  };

  // 1. NPS Sound Gallery
  if (!opts.skipGallery) {
    console.log('\n[1/3] Discovering NPS Natural Sounds Gallery...');
    const galleryPages = await discoverNpsGallery();
    console.log(`  Found ${galleryPages.length} gallery pages.`);

    for (let i = 0; i < galleryPages.length; i++) {
      const p = galleryPages[i];
      try {
        const html = await fetchText(p.pageUrl);
        const audioUrls = extractAudioUrls(html, p.pageUrl);
        const meta = extractPageMetadata(html);
        if (audioUrls.length === 0) {
          stats.noAudioPages.push(p.pageUrl);
          continue;
        }
        const catFolder = slugifyFolder(p.category);
        const baseTitle = slugifyFile(meta.title || p.label);

        for (let j = 0; j < audioUrls.length; j++) {
          const audioUrl = audioUrls[j];
          stats.discovered++;
          const ext = path.extname(new URL(audioUrl).pathname).toLowerCase() || '.mp3';
          const suffix = audioUrls.length > 1 ? `_${j + 1}` : '';
          const relPath = `Gallery/${catFolder}/${baseTitle}${suffix}${ext}`;
          const destPath = path.join(opts.outDir, ...relPath.split('/'));

          if (opts.dryRun) {
            console.log(`  [DRY] ${relPath} <- ${audioUrl}`);
          } else {
            const dl = await downloadFile(audioUrl, destPath);
            stats[dl.status]++;
            stats.totalBytes += dl.bytes;
            const dur = await probeDurationSec(destPath);
            const clipHint = humanizeAudioFilename(audioUrl);
            const isNatural = !/Machines|Cultural/i.test(p.category);
            catalog[relPath] = {
              description: [
                audioUrls.length > 1 && clipHint ? `${clipHint}.` : '',
                meta.description || `${meta.title || p.label} (${p.category}, NPS Natural Sounds Gallery)`,
              ].filter(Boolean).join(' '),
              tags: buildTags([p.category, meta.title, p.label, clipHint, 'nps', isNatural ? 'nature' : '']),
              kind: dur !== null && dur >= 12 ? 'bed' : 'sfx',
              license: 'Public Domain (National Park Service)',
              loopable: dur !== null && dur >= 20,
              sourceUrl: p.pageUrl,
              audioUrl,
              category: p.category,
              durationSec: dur ?? undefined,
            };
          }
        }
        if ((i + 1) % 15 === 0 || i === galleryPages.length - 1) {
          console.log(`  Gallery progress: ${i + 1}/${galleryPages.length} pages`);
        }
      } catch (err) {
        stats.failed.push({ url: p.pageUrl, error: String(err.message || err) });
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // 2. Yellowstone Sound Library
  if (!opts.skipYellowstone) {
    console.log('\n[2/3] Discovering Yellowstone National Park Sound Library...');
    const yellPages = await discoverYellowstone();
    console.log(`  Found ${yellPages.length} Yellowstone pages.`);

    for (let i = 0; i < yellPages.length; i++) {
      const p = yellPages[i];
      try {
        const html = await fetchText(p.pageUrl);
        const audioUrls = extractAudioUrls(html, p.pageUrl);
        const meta = extractPageMetadata(html);
        if (audioUrls.length === 0) {
          stats.noAudioPages.push(p.pageUrl);
          continue;
        }
        const baseTitle = slugifyFile(meta.title || p.label);

        for (let j = 0; j < audioUrls.length; j++) {
          const audioUrl = audioUrls[j];
          stats.discovered++;
          const ext = path.extname(new URL(audioUrl).pathname).toLowerCase() || '.mp3';
          const suffix = audioUrls.length > 1 ? `_${j + 1}` : '';
          const relPath = `Yellowstone/${baseTitle}${suffix}${ext}`;
          const destPath = path.join(opts.outDir, ...relPath.split('/'));

          if (opts.dryRun) {
            console.log(`  [DRY] ${relPath} <- ${audioUrl}`);
          } else {
            const dl = await downloadFile(audioUrl, destPath);
            stats[dl.status]++;
            stats.totalBytes += dl.bytes;
            const dur = await probeDurationSec(destPath);
            const clipHint = humanizeAudioFilename(audioUrl);
            catalog[relPath] = {
              description: [
                audioUrls.length > 1 && clipHint ? `${clipHint}.` : '',
                meta.description || `${meta.title || p.label} (Yellowstone National Park Sound Library)`,
              ].filter(Boolean).join(' '),
              tags: buildTags(['yellowstone', meta.title, p.label, clipHint, 'nps', 'nature', 'wildlife']),
              kind: dur !== null && dur >= 12 ? 'bed' : 'sfx',
              license: 'Public Domain (National Park Service — Yellowstone)',
              loopable: dur !== null && dur >= 20,
              sourceUrl: p.pageUrl,
              audioUrl,
              category: 'Yellowstone',
              durationSec: dur ?? undefined,
            };
          }
        }
        if ((i + 1) % 15 === 0 || i === yellPages.length - 1) {
          console.log(`  Yellowstone progress: ${i + 1}/${yellPages.length} pages`);
        }
      } catch (err) {
        stats.failed.push({ url: p.pageUrl, error: String(err.message || err) });
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // 3. Internet Archive — Natural Sounds Field Recording Archive
  if (!opts.skipArchive) {
    console.log(`\n[3/3] Fetching Internet Archive NaturalSoundsFieldRecordingArchive (${opts.archiveFormat})...`);
    const files = await discoverArchiveOrg(opts.archiveFormat);
    const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;
    console.log(`  Found ${files.length} files (${totalMb.toFixed(1)} MB total).`);

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      stats.discovered++;
      const relPath = `FieldRecordings_ArchiveOrg/${f.name}`;
      const destPath = path.join(opts.outDir, ...relPath.split('/'));
      try {
        if (opts.dryRun) {
          console.log(`  [DRY] ${relPath} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
        } else {
          process.stdout.write(`  [${i + 1}/${files.length}] ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)... `);
          const dl = await downloadFile(f.url, destPath, f.size || null);
          stats[dl.status]++;
          stats.totalBytes += dl.bytes;
          console.log(dl.status);
          const dur = f.lengthSec ?? (await probeDurationSec(destPath));
          const desc = describeArchiveFilename(f.name);
          catalog[relPath] = {
            description: desc,
            tags: buildTags(['field', 'recording', 'ambience', 'bed', 'nps', f.name.replace(/^\d{8}/, '').replace(/\.[^.]+$/, '')]),
            kind: 'bed',
            license: 'Public Domain (NPS Natural Sounds Field Recording Archive)',
            loopable: true,
            sourceUrl: 'https://archive.org/details/NaturalSoundsFieldRecordingArchive',
            audioUrl: f.url,
            category: 'FieldRecordings',
            durationSec: dur ? Math.round(dur * 100) / 100 : undefined,
          };
        }
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        stats.failed.push({ url: f.url, error: String(err.message || err) });
      }
    }
  }

  if (!opts.dryRun) {
    await fs.mkdir(opts.outDir, { recursive: true });
    const sortedCatalog = Object.fromEntries(
      Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))
    );
    const tmpCatalog = `${catalogPath}.tmp`;
    await fs.writeFile(tmpCatalog, JSON.stringify(sortedCatalog, null, 2) + '\n', 'utf8');
    await fs.rename(tmpCatalog, catalogPath);
    console.log(`\nWrote ${Object.keys(sortedCatalog).length} entries to ${catalogPath}`);
  }

  console.log('\n=== Harvest Summary ===');
  console.log(`Discovered audio files: ${stats.discovered}`);
  console.log(`Downloaded:             ${stats.downloaded}`);
  console.log(`Skipped (cached):       ${stats.skipped}`);
  console.log(`Total size on disk:     ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Pages without audio:    ${stats.noAudioPages.length}`);
  console.log(`Errors:                 ${stats.failed.length}`);
  if (stats.noAudioPages.length > 0) {
    console.log('No-audio pages:', stats.noAudioPages);
  }
  if (stats.failed.length > 0) {
    console.log('Failures:', stats.failed);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
