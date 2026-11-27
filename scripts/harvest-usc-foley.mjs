#!/usr/bin/env node
/**
 * Polite, resumable harvester for curated CC0 1.0 Public Domain sound effects from
 * the USC Cinema / Sunset Editorial ("Red Library" & "Gold Tape") collections on Archive.org.
 *
 * Strictly verifies CC0 1.0 license metadata on every item before downloading.
 * Downloads lossless `.flac` files into clean category folders + generates `catalog.json`
 * compatible with The Booth's `docs/asset-library-spec.md`.
 *
 * Usage:
 *   node scripts/harvest-usc-foley.mjs --out "E:\AudioLibraries\USC_Cinema_Foley_CC0"
 *   node scripts/harvest-usc-foley.mjs --out "E:\AudioLibraries\USC_Cinema_Foley_CC0" --concurrency 4
 */

import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT = 'TheBooth-USC-FoleyHarvester/1.0 (CC0 Public Domain Audio Drama Library)';

const CURATED_COLLECTIONS = [
  // Doors & Creaks
  { id: 'Red_Library_Doors', folder: 'Doors', extraTags: ['door', 'doors', 'castle', 'slam', 'hinge', 'knock', 'latch'], isAmbient: false },
  { id: 'GOLD_TAPE_31_Doors', folder: 'Doors', extraTags: ['door', 'doors', 'slam', 'wood', 'metal', 'rattle'], isAmbient: false },
  { id: 'Red_Library_Creaks', folder: 'Creaks', extraTags: ['creak', 'creaking', 'wood', 'door', 'floor', 'hinge'], isAmbient: false },
  { id: 'GOLD_TAPE_27_Creaks', folder: 'Creaks', extraTags: ['creak', 'creaking', 'wood', 'squeak'], isAmbient: false },

  // Footsteps (all 4 reels)
  { id: 'Red_Library_Footsteps_1', folder: 'Footsteps', extraTags: ['footsteps', 'walking', 'steps', 'foley'], isAmbient: false },
  { id: 'Red_Library_Footsteps_2', folder: 'Footsteps', extraTags: ['footsteps', 'walking', 'boots', 'gravel', 'concrete', 'foley'], isAmbient: false },
  { id: 'Red_Library_Footsteps_3', folder: 'Footsteps', extraTags: ['footsteps', 'stairs', 'wood', 'dirt', 'running', 'foley'], isAmbient: false },
  { id: 'Red_Library_Footsteps_4', folder: 'Footsteps', extraTags: ['footsteps', 'walking', 'steps', 'foley'], isAmbient: false },

  // Foley Props (all 5 reels)
  { id: 'Red_Library_Foley_Props_1', folder: 'Foley_Props', extraTags: ['foley', 'props', 'interior'], isAmbient: false },
  { id: 'Red_Library_Foley_Props_2', folder: 'Foley_Props', extraTags: ['foley', 'props', 'paper', 'wood', 'dragging'], isAmbient: false },
  { id: 'Red_Library_Foley_Props_3', folder: 'Foley_Props', extraTags: ['foley', 'props', 'interior'], isAmbient: false },
  { id: 'Red_Library_Foley_Props_4', folder: 'Foley_Props', extraTags: ['foley', 'props', 'interior'], isAmbient: false },
  { id: 'Red_Library_Foley_Props_5', folder: 'Foley_Props', extraTags: ['foley', 'props', 'glass', 'interior'], isAmbient: false },

  // Glass, Crashes, Impacts & Body Falls
  { id: 'Red_Library_Crashes', folder: 'Crashes_Glass', extraTags: ['crash', 'glass', 'shatter', 'break', 'wood'], isAmbient: false },
  { id: 'GOLD_TAPE_26_Crashes', folder: 'Crashes_Glass', extraTags: ['crash', 'glass', 'shatter', 'window', 'break'], isAmbient: false },
  { id: 'Red_Library_Impacts', folder: 'Impacts_BodyFalls', extraTags: ['impact', 'hit', 'thud', 'strike'], isAmbient: false },
  { id: 'GOLD_TAPE_24_Body_Falls', folder: 'Impacts_BodyFalls', extraTags: ['body', 'fall', 'thud', 'impact', 'drop'], isAmbient: false },

  // Metal & Tools (chains, iron, hammers/stakes)
  { id: 'Red_Library_Metal', folder: 'Metal_Tools', extraTags: ['metal', 'iron', 'chain', 'clank', 'clang'], isAmbient: false },
  { id: 'Red_Library_Tools', folder: 'Metal_Tools', extraTags: ['tools', 'hammer', 'wood', 'metal', 'foley'], isAmbient: false },

  // Period Drama: Horses, Carriages & Wagons
  { id: 'Red_Library_Wagons', folder: 'Horses_Wagons', extraTags: ['wagon', 'carriage', 'coach', 'wheels', 'horse'], isAmbient: false },
  { id: 'GOLD_TAPE_52_Wagons', folder: 'Horses_Wagons', extraTags: ['wagon', 'carriage', 'coach', 'wheels'], isAmbient: false },
  { id: 'GOLD_TAPE_38_Horses', folder: 'Horses_Wagons', extraTags: ['horse', 'horses', 'hooves', 'gallop', 'whinny'], isAmbient: false },
  { id: 'Red_Library_Animals_Horses_1', folder: 'Horses_Wagons', extraTags: ['horse', 'horses', 'hooves', 'trot', 'carriage'], isAmbient: false },

  // Fire, Bells, Storms, Boats, Dogs, Ambience
  { id: 'Red_Library_Fire', folder: 'Fire', extraTags: ['fire', 'fireplace', 'flames', 'crackle', 'hearth'], isAmbient: true },
  { id: 'Red_Library_Bells_Horns_Whistles', folder: 'Bells_Chimes', extraTags: ['bell', 'bells', 'chime', 'church', 'whistle'], isAmbient: false },
  { id: 'GOLD_TAPE_19_20_Bells_Buzzers', folder: 'Bells_Chimes', extraTags: ['bell', 'bells', 'chime', 'clock', 'ring'], isAmbient: false },
  { id: 'GOLD_TAPE_46_Thunderstorm_Rain', folder: 'Weather_Storms', extraTags: ['thunder', 'thunderstorm', 'rain', 'storm', 'weather'], isAmbient: true },
  { id: 'GOLD_TAPE_55_56_Weather-Wind', folder: 'Weather_Storms', extraTags: ['wind', 'howling', 'storm', 'weather', 'gale'], isAmbient: true },
  { id: 'Red_Library_Boats', folder: 'Boats', extraTags: ['boat', 'ship', 'sailing', 'water', 'ocean', 'creak'], isAmbient: true },
  { id: 'Red_Library_Animals_Dogs', folder: 'Dogs_Wolves', extraTags: ['dog', 'dogs', 'bark', 'howl', 'growl', 'wolf'], isAmbient: false },
  { id: 'Red_Library_Ambience_1', folder: 'Ambience', extraTags: ['ambience', 'room', 'atmosphere', 'bed', 'background'], isAmbient: true },
];

function parseArgs(argv) {
  const opts = {
    outDir: 'E:\\AudioLibraries\\USC_Cinema_Foley_CC0',
    concurrency: 4,
    format: 'flac',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) opts.outDir = argv[++i];
    else if (argv[i] === '--concurrency' && argv[i + 1]) opts.concurrency = Math.max(1, Math.min(8, Number(argv[++i]) || 4));
    else if (argv[i] === '--format' && argv[i + 1]) opts.format = argv[++i].toLowerCase();
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeCueName(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Strip tape/track prefix like "R09-01-" or "G31-29-"
  return base
    .replace(/^[A-Z]\d{1,3}(?:\.\d+)?[-_]\d{1,3}[-_\s]*/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTags(parts) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'out', 'off', 'red', 'gold', 'tape', 'library']);
  const set = new Set();
  for (const raw of parts) {
    if (!raw) continue;
    const words = raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    for (const w of words) {
      if (w.length >= 2 && !stop.has(w) && !/^\d+$/.test(w)) set.add(w);
    }
  }
  return [...set].slice(0, 18);
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000 * attempt);
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
    // not present
  }

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fssync.createWriteStream(tmpPath));
      const st = await fs.stat(tmpPath);
      if (st.size === 0) throw new Error('Downloaded 0 bytes');
      if (expectedSize && st.size !== expectedSize) {
        throw new Error(`Size mismatch: got ${st.size}, expected ${expectedSize}`);
      }
      await fs.rename(tmpPath, destPath);
      return { status: 'downloaded', bytes: st.size };
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (attempt === 4) throw err;
      await sleep(1500 * attempt);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`USC Cinema CC0 Foley Harvester -> ${opts.outDir} (format: .${opts.format}, concurrency: ${opts.concurrency})`);

  const catalogPath = path.join(opts.outDir, 'catalog.json');
  let catalog = {};
  try {
    catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  } catch {
    catalog = {};
  }

  // 1. Discover all tasks across curated collections (verifying CC0 strictly)
  console.log(`\n[1/2] Fetching Archive.org metadata for ${CURATED_COLLECTIONS.length} collections...`);
  const tasks = [];
  const usedRelPaths = new Set();

  for (const col of CURATED_COLLECTIONS) {
    const meta = await fetchJson(`https://archive.org/metadata/${col.id}`);
    const lic = String(meta.metadata?.licenseurl || '');
    if (!/creativecommons\.org\/publicdomain\/zero\/1\.0/i.test(lic)) {
      console.warn(`  SKIPPING ${col.id} — license not strictly CC0 1.0 (${lic || 'none'})`);
      continue;
    }

    const suffix = `.${opts.format}`;
    const files = (meta.files || []).filter(
      (f) => typeof f.name === 'string' && f.name.toLowerCase().endsWith(suffix)
    );

    for (const f of files) {
      const safeName = sanitizeFilename(path.basename(f.name));
      let relPath = `${col.folder}/${safeName}`;
      if (usedRelPaths.has(relPath.toLowerCase())) {
        const ext = path.extname(safeName);
        const stem = path.basename(safeName, ext);
        relPath = `${col.folder}/${col.id}_${stem}${ext}`;
      }
      usedRelPaths.add(relPath.toLowerCase());

      const cueTitle = humanizeCueName(f.name);
      const dur = f.length ? Math.round(parseFloat(f.length) * 100) / 100 : null;
      const encodedName = f.name.split('/').map(encodeURIComponent).join('/');

      tasks.push({
        col,
        relPath,
        destPath: path.join(opts.outDir, ...relPath.split('/')),
        url: `https://archive.org/download/${col.id}/${encodedName}`,
        expectedSize: Number(f.size || 0) || null,
        cueTitle,
        durationSec: Number.isFinite(dur) ? dur : null,
        collectionTitle: meta.metadata?.title || col.id,
      });
    }
  }

  const estMb = tasks.reduce((s, t) => s + (t.expectedSize || 0), 0) / 1024 / 1024;
  console.log(`  Verified ${tasks.length} CC0 .${opts.format} cues (~${estMb.toFixed(1)} MB total).`);

  // 2. Download with bounded concurrency
  console.log(`\n[2/2] Downloading files...`);
  let idx = 0;
  let completed = 0;
  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  const failed = [];

  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= tasks.length) return;
      const t = tasks[myIdx];
      try {
        const res = await downloadFile(t.url, t.destPath, t.expectedSize);
        if (res.status === 'downloaded') downloaded++;
        else skipped++;
        totalBytes += res.bytes;

        const dur = t.durationSec;
        const kind = t.col.isAmbient || (dur !== null && dur >= 25) ? 'bed' : 'sfx';
        const multiVariation = !t.col.isAmbient && dur !== null && dur >= 15;

        catalog[t.relPath] = {
          description: `${t.cueTitle} (${t.collectionTitle}, USC Cinema / Sunset Editorial CC0 Foley Archive).`,
          tags: buildTags([t.col.folder, ...t.col.extraTags, t.cueTitle, 'usc', 'cinema', 'foley', 'cc0']),
          kind,
          license: 'CC0 1.0 Universal (USC Cinema / Sunset Editorial — Craig Smith)',
          loopable: t.col.isAmbient && dur !== null && dur >= 20,
          multiVariation,
          sourceUrl: `https://archive.org/details/${t.col.id}`,
          audioUrl: t.url,
          category: t.col.folder,
          durationSec: dur ?? undefined,
        };
      } catch (err) {
        failed.push({ relPath: t.relPath, url: t.url, error: String(err.message || err) });
      } finally {
        completed++;
        if (completed % 50 === 0 || completed === tasks.length) {
          console.log(`  Progress: ${completed}/${tasks.length} (${downloaded} new, ${skipped} cached, ${failed.length} errors, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  await fs.mkdir(opts.outDir, { recursive: true });
  const sortedCatalog = Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))
  );
  const tmpCatalog = `${catalogPath}.tmp`;
  await fs.writeFile(tmpCatalog, JSON.stringify(sortedCatalog, null, 2) + '\n', 'utf8');
  await fs.rename(tmpCatalog, catalogPath);

  console.log(`\nWrote ${Object.keys(sortedCatalog).length} entries to ${catalogPath}`);
  console.log('\n=== Harvest Summary ===');
  console.log(`Verified cues:      ${tasks.length}`);
  console.log(`Downloaded:         ${downloaded}`);
  console.log(`Skipped (cached):   ${skipped}`);
  console.log(`Total size on disk: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Errors:             ${failed.length}`);
  if (failed.length > 0) {
    console.log('Failures:', failed.slice(0, 20));
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
