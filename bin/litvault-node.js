#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const VERSION = "0.1.5";
const FALLBACK_LIBRARY = path.join(os.homedir(), "litvault-library");
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i;
const DOI_GLOBAL_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi;

function usage() {
  return `litvault ${VERSION}

Usage:
  litvault [--library DIR] init [DIR]
  litvault [--library DIR] add FILE_OR_DIR... [--doi DOI] [--title TITLE] [--tag TAG] [--no-crossref] [--no-recursive] [--quiet] [--verbose]
  litvault [--library DIR] import-dois DOI... [--file dois.txt] [--tag TAG] [--no-crossref]
  litvault [--library DIR] get QUERY... --to DIR [--file queries.txt] [--name "{citekey}.pdf"]
  litvault [--library DIR] info QUERY
  litvault [--library DIR] search QUERY [--limit N]
  litvault [--library DIR] list [--limit N]
  litvault [--library DIR] stats [--json]
  litvault [--library DIR] export-bib [QUERY...] [--file queries.txt] [--out FILE]
  litvault [--library DIR] sync zotero [--dry-run] [--no-copy-pdfs]
  litvault config get
  litvault config set library DIR
  litvault config unset library
  litvault config path

Examples:
  litvault init ~/litvault-library
  litvault config set library /Volumes/ResearchSSD/litvault-library
  litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
  litvault add ~/Downloads/papers
  litvault import-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
  litvault import-dois --file dois.txt
  litvault stats
  litvault get 10.1038/s41586-020-2649-2 10.1145/3510003.3510101 --to ~/Desktop/refs
  litvault export-bib 10.1038/s41586-020-2649-2 --out refs.bib
  litvault sync zotero --dry-run
`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolvePath(value) {
  return path.resolve(expandHome(value));
}

function configDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(expandHome(process.env.XDG_CONFIG_HOME), "litvault");
  return path.join(os.homedir(), ".config", "litvault");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function readConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config ${file}: ${error.message}`);
  }
}

function writeConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function defaultLibraryInfo() {
  if (process.env.LITVAULT_LIBRARY) {
    return {
      path: resolvePath(process.env.LITVAULT_LIBRARY),
      source: "LITVAULT_LIBRARY",
    };
  }
  const config = readConfig();
  if (config.library) {
    return {
      path: resolvePath(config.library),
      source: configPath(),
    };
  }
  return {
    path: resolvePath(FALLBACK_LIBRARY),
    source: "built-in default",
  };
}

function normalizeDoi(value) {
  let doi = String(value || "")
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();

  doi = doi.replace(/[ \t\r\n.,;:\]}>]+$/g, "");
  while (doi.endsWith(")") && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) {
    doi = doi.slice(0, -1);
  }

  return doi.toLowerCase();
}

function findDoiInText(text) {
  const match = DOI_RE.exec(text || "");
  return match ? normalizeDoi(match[1]) : null;
}

function findDoisInText(text) {
  return Array.from(String(text || "").matchAll(DOI_GLOBAL_RE), match => normalizeDoi(match[1]));
}

async function findDoiInFile(file) {
  const handle = await fsp.open(file, "r");
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, 4_000_000);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return findDoiInText(buffer.toString("utf8")) || findDoiInText(buffer.toString("latin1"));
  } finally {
    await handle.close();
  }
}

async function ensureLibrary(library) {
  await fsp.mkdir(path.join(library, "objects", "sha256"), { recursive: true });
  await fsp.mkdir(path.join(library, "exports"), { recursive: true });
  await fsp.mkdir(path.join(library, "notes"), { recursive: true });
  const manifest = path.join(library, "manifest.json");
  if (!fs.existsSync(manifest)) {
    await writeJsonAtomic(manifest, { version: 1, nextId: 1, papers: [] });
  }
}

async function readDb(library) {
  await ensureLibrary(library);
  const text = await fsp.readFile(path.join(library, "manifest.json"), "utf8");
  const db = JSON.parse(text);
  db.nextId ||= 1;
  db.papers ||= [];
  return db;
}

async function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(temp, file);
}

async function writeDb(library, db) {
  await writeJsonAtomic(path.join(library, "manifest.json"), db);
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", chunk => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function storePdf(library, source) {
  const digest = await sha256File(source);
  return storePdfWithHash(library, source, digest);
}

async function storePdfWithHash(library, source, digest) {
  const rel = path.join("objects", "sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}.pdf`);
  const dest = path.join(library, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    await fsp.copyFile(source, dest);
  }
  return { sha256: digest, path: rel };
}

function slugify(text, maxLen = 40) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen)
    .replace(/-$/g, "");
  return slug || "paper";
}

function makeCitekey(authors, year, title, fallback) {
  const first = (authors || [])[0] || "";
  const lastName = first.trim().split(/\s+/).filter(Boolean).pop();
  const pieces = [year || "noyear", slugify(title, 28)];
  if (lastName) pieces.unshift(slugify(lastName, 20));
  return pieces.join("").replace(/-/g, "") || slugify(fallback, 32);
}

function uniqueCitekey(db, base, existingId) {
  let candidate = base;
  let suffix = 2;
  while (db.papers.some(p => p.citekey === candidate && p.id !== existingId)) {
    candidate = `${base}${suffix++}`;
  }
  return candidate;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "litvault/0.1",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function first(values, fallback = "") {
  return Array.isArray(values) && values.length ? values[0] : fallback;
}

function yearFromCrossref(message) {
  for (const key of ["published-print", "published-online", "published", "issued"]) {
    const part = first(message?.[key]?.["date-parts"]);
    if (part && part[0]) return Number(part[0]);
  }
  return null;
}

async function fetchCrossref(doi) {
  const encoded = encodeURIComponent(doi);
  const payload = await fetchJson(`https://api.crossref.org/works/${encoded}`);
  const message = payload.message || {};
  return {
    doi: normalizeDoi(message.DOI || doi),
    title: first(message.title),
    authors: (message.author || [])
      .map(a => [a.given, a.family].filter(Boolean).join(" ").trim())
      .filter(Boolean),
    year: yearFromCrossref(message),
    venue: first(message["container-title"]),
    publisher: message.publisher || "",
    url: message.URL || "",
    type: message.type || "",
  };
}

async function metadataForDoi(doi, title = "", noCrossref = false) {
  let metadata = { doi: normalizeDoi(doi), title, authors: [] };
  if (!noCrossref) {
    try {
      metadata = { ...metadata, ...(await fetchCrossref(metadata.doi)) };
    } catch (error) {
      console.error(`Warning: Crossref lookup failed for ${metadata.doi}: ${error.message}`);
    }
  }
  if (title) metadata.title = title;
  return metadata;
}

async function upsertPaper(library, metadata, pdf, tags = []) {
  const db = await readDb(library);
  const doi = metadata.doi ? normalizeDoi(metadata.doi) : null;
  let paper = doi ? db.papers.find(p => p.doi === doi) : null;
  if (!paper && metadata.zoteroKey) {
    paper = db.papers.find(p => p.zoteroKey === metadata.zoteroKey && p.zoteroLibrary === metadata.zoteroLibrary);
  }

  const pdfData = pdf ? await storePdf(library, pdf) : {};
  const timestamp = nowIso();
  const base = makeCitekey(metadata.authors || [], metadata.year, metadata.title || "", doi || pdfData.sha256 || "paper");

  if (!paper) {
    paper = { id: db.nextId++, addedAt: timestamp };
    db.papers.push(paper);
  }

  const existingId = paper.id;
  paper.doi = doi || paper.doi || null;
  paper.title = metadata.title || paper.title || "";
  paper.authors = metadata.authors?.length ? metadata.authors : paper.authors || [];
  paper.year = metadata.year || paper.year || null;
  paper.venue = metadata.venue || paper.venue || "";
  paper.publisher = metadata.publisher || paper.publisher || "";
  paper.url = metadata.url || paper.url || "";
  paper.type = metadata.type || paper.type || "";
  paper.citekey = paper.citekey || uniqueCitekey(db, base, existingId);
  paper.pdfSha256 = pdfData.sha256 || paper.pdfSha256 || null;
  paper.pdfPath = pdfData.path || paper.pdfPath || null;
  paper.tags = Array.from(new Set([...(paper.tags || []), ...tags])).sort();
  paper.zoteroKey = metadata.zoteroKey || paper.zoteroKey || null;
  paper.zoteroLibrary = metadata.zoteroLibrary || paper.zoteroLibrary || null;
  paper.updatedAt = timestamp;

  await writeDb(library, db);
  return paper;
}

function buildDbIndexes(db) {
  const byDoi = new Map();
  const byPdfSha256 = new Map();
  const byZotero = new Map();
  for (const paper of db.papers || []) {
    if (paper.doi) byDoi.set(paper.doi, paper);
    if (paper.pdfSha256) byPdfSha256.set(paper.pdfSha256, paper);
    if (paper.zoteroKey) byZotero.set(`${paper.zoteroLibrary || ""}:${paper.zoteroKey}`, paper);
  }
  return { byDoi, byPdfSha256, byZotero };
}

function applyMetadataToPaper(db, indexes, metadata, pdfData, tags = []) {
  const doi = metadata.doi ? normalizeDoi(metadata.doi) : null;
  let paper = doi ? indexes.byDoi.get(doi) : null;
  if (!paper && metadata.zoteroKey) {
    paper = indexes.byZotero.get(`${metadata.zoteroLibrary || ""}:${metadata.zoteroKey}`);
  }

  const timestamp = nowIso();
  const base = makeCitekey(metadata.authors || [], metadata.year, metadata.title || "", doi || pdfData?.sha256 || "paper");
  const isNew = !paper;

  if (!paper) {
    paper = { id: db.nextId++, addedAt: timestamp };
    db.papers.push(paper);
  }

  const existingId = paper.id;
  paper.doi = doi || paper.doi || null;
  paper.title = metadata.title || paper.title || "";
  paper.authors = metadata.authors?.length ? metadata.authors : paper.authors || [];
  paper.year = metadata.year || paper.year || null;
  paper.venue = metadata.venue || paper.venue || "";
  paper.publisher = metadata.publisher || paper.publisher || "";
  paper.url = metadata.url || paper.url || "";
  paper.type = metadata.type || paper.type || "";
  paper.citekey = paper.citekey || uniqueCitekey(db, base, existingId);
  paper.pdfSha256 = pdfData?.sha256 || paper.pdfSha256 || null;
  paper.pdfPath = pdfData?.path || paper.pdfPath || null;
  paper.tags = Array.from(new Set([...(paper.tags || []), ...tags])).sort();
  paper.zoteroKey = metadata.zoteroKey || paper.zoteroKey || null;
  paper.zoteroLibrary = metadata.zoteroLibrary || paper.zoteroLibrary || null;
  paper.updatedAt = timestamp;

  if (paper.doi) indexes.byDoi.set(paper.doi, paper);
  if (paper.pdfSha256) indexes.byPdfSha256.set(paper.pdfSha256, paper);
  if (paper.zoteroKey) indexes.byZotero.set(`${paper.zoteroLibrary || ""}:${paper.zoteroKey}`, paper);
  return { paper, isNew };
}

async function addPdfBatch(library, files, options) {
  const db = await readDb(library);
  const indexes = buildDbIndexes(db);
  const seenInputHashes = new Map();
  let imported = 0;
  let updated = 0;
  let skippedNoDoi = 0;
  let skippedExistingPdf = 0;
  let skippedDuplicateInput = 0;
  let processed = 0;
  const progress = makeProgress(files.length, options.progress);
  const state = () => ({ processed, imported, updated, skippedNoDoi, skippedExistingPdf, skippedDuplicateInput });
  const log = message => {
    if (options.verbose) console.log(message);
  };
  progress.render(state());

  for (const file of files) {
    const digest = await sha256File(file);
    if (seenInputHashes.has(digest)) {
      skippedDuplicateInput++;
      processed++;
      log(`Skipping duplicate input PDF: ${file}`);
      progress.render(state());
      continue;
    }
    seenInputHashes.set(digest, file);

    const existingByHash = indexes.byPdfSha256.get(digest);
    if (existingByHash) {
      skippedExistingPdf++;
      processed++;
      log(`Skipping already stored PDF: ${file}  DOI: ${existingByHash.doi || "-"}  citekey: ${existingByHash.citekey || "-"}`);
      progress.render(state());
      continue;
    }

    const doi = options.doiArg ? normalizeDoi(options.doiArg) : await findDoiInFile(file);
    if (!doi) {
      skippedNoDoi++;
      processed++;
      log(`Skipping without DOI: ${file}`);
      progress.render(state());
      continue;
    }

    let paper = indexes.byDoi.get(doi);
    let metadata = { doi, title: options.title || "", authors: [] };
    if (!paper || !paper.title || !paper.authors?.length || !paper.year) {
      metadata = await metadataForDoi(doi, options.title || "", options.noCrossref);
    } else if (options.title) {
      metadata.title = options.title;
    }

    const pdfData = await storePdfWithHash(library, file, digest);
    const result = applyMetadataToPaper(db, indexes, metadata, pdfData, options.tags);
    paper = result.paper;
    if (result.isNew) imported++;
    else updated++;
    processed++;
    log(`${result.isNew ? "Stored" : "Updated"}: ${paper.citekey}  DOI: ${paper.doi}  PDF: ${file}`);
    progress.render(state());
  }

  progress.finish();
  await writeDb(library, db);
  return {
    imported,
    updated,
    skippedNoDoi,
    skippedExistingPdf,
    skippedDuplicateInput,
    processed,
    library,
  };
}

async function collectPdfPaths(inputs, recursive = true) {
  const found = [];
  for (const input of inputs) {
    const target = path.resolve(expandHome(input));
    if (!fs.existsSync(target)) throw new Error(`Path not found: ${target}`);
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        const child = path.join(target, entry.name);
        if (entry.isDirectory() && recursive) {
          found.push(...await collectPdfPaths([child], recursive));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
          found.push(child);
        }
      }
    } else if (stat.isFile() && target.toLowerCase().endsWith(".pdf")) {
      found.push(target);
    }
  }
  return Array.from(new Set(found));
}

async function pathSize(target) {
  if (!fs.existsSync(target)) return { bytes: 0, files: 0 };
  const stat = await fsp.stat(target);
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  if (!stat.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = await pathSize(child);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      const childStat = await fsp.stat(child);
      bytes += childStat.size;
      files++;
    }
  }
  return { bytes, files };
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function makeProgress(total, enabled) {
  let lastLength = 0;
  function render(state) {
    if (!enabled) return;
    const done = state.processed || 0;
    const width = 24;
    const filled = total ? Math.floor((done / total) * width) : 0;
    const skipped = (state.skippedExistingPdf || 0) + (state.skippedDuplicateInput || 0) + (state.skippedNoDoi || 0);
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const text = `Scanning PDFs [${bar}] ${done}/${total} imported:${state.imported || 0} updated:${state.updated || 0} skipped:${skipped}`;
    process.stderr.write(`\r${text.padEnd(lastLength, " ")}`);
    lastLength = text.length;
  }
  function finish() {
    if (enabled) process.stderr.write("\n");
  }
  return { render, finish };
}

async function readListFile(file) {
  const text = await fsp.readFile(path.resolve(expandHome(file)), "utf8");
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const dois = findDoisInText(trimmed);
    if (dois.length) {
      values.push(...dois);
    } else {
      values.push(trimmed);
    }
  }
  return values;
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function findPaper(library, query) {
  const db = await readDb(library);
  const normalized = normalizeDoi(query);
  return db.papers.find(p => p.doi === normalized)
    || db.papers.find(p => p.citekey === query)
    || (/^\d+$/.test(query) ? db.papers.find(p => p.id === Number(query)) : null)
    || db.papers.find(p => (p.title || "").toLowerCase().includes(String(query).toLowerCase()));
}

function compactAuthors(authors) {
  if (!authors?.length) return "";
  return authors.length === 1 ? authors[0] : `${authors[0]} et al.`;
}

function printRow(paper) {
  const line = [
    String(paper.id).padStart(4),
    String(paper.citekey || "-").padEnd(32),
    String(paper.year || "-").padEnd(6),
    compactAuthors(paper.authors).padEnd(28),
    paper.title || "(untitled)",
  ].join("  ");
  console.log(line);
  if (paper.doi) console.log(`      DOI: ${paper.doi}`);
}

function formatName(pattern, paper) {
  const first = paper.authors?.[0]?.trim().split(/\s+/).pop() || "unknown";
  const name = pattern
    .replaceAll("{id}", String(paper.id))
    .replaceAll("{doi}", String(paper.doi || "").replaceAll("/", "_"))
    .replaceAll("{citekey}", paper.citekey || `paper${paper.id}`)
    .replaceAll("{year}", String(paper.year || "noyear"))
    .replaceAll("{first_author}", slugify(first, 30))
    .replaceAll("{title}", slugify(paper.title || "paper", 80));
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

function bibtexEscape(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}");
}

function toBibtex(paper) {
  const entryType = ["journal-article", "journalArticle", "article"].includes(paper.type) ? "article" : "misc";
  const fields = {
    title: paper.title,
    author: (paper.authors || []).join(" and "),
    year: paper.year,
    journal: paper.venue,
    doi: paper.doi,
    url: paper.url,
    publisher: paper.publisher,
  };
  const lines = [`@${entryType}{${paper.citekey || `paper${paper.id}`},`];
  for (const [key, value] of Object.entries(fields)) {
    if (value) lines.push(`  ${key} = {${bibtexEscape(value)}},`);
  }
  lines.push("}");
  return lines.join("\n");
}

async function computeStats(library, db) {
  const papers = db.papers || [];
  const withPdf = papers.filter(p => p.pdfPath).length;
  const missingPdf = papers.filter(p => p.pdfPath && !fs.existsSync(path.join(library, p.pdfPath))).length;
  const withoutPdf = papers.length - withPdf;
  const withDoi = papers.filter(p => p.doi).length;
  const withoutDoi = papers.length - withDoi;
  const years = papers
    .map(p => p.year)
    .filter(year => year !== null && year !== undefined && year !== "" && Number.isFinite(Number(year)))
    .map(Number);
  const tagCounts = new Map();
  const typeCounts = new Map();
  const venueCounts = new Map();
  const doiCounts = new Map();
  const pdfHashCounts = new Map();

  for (const paper of papers) {
    for (const tag of paper.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    if (paper.type) typeCounts.set(paper.type, (typeCounts.get(paper.type) || 0) + 1);
    if (paper.venue) venueCounts.set(paper.venue, (venueCounts.get(paper.venue) || 0) + 1);
    if (paper.doi) doiCounts.set(paper.doi, (doiCounts.get(paper.doi) || 0) + 1);
    if (paper.pdfSha256) pdfHashCounts.set(paper.pdfSha256, (pdfHashCounts.get(paper.pdfSha256) || 0) + 1);
  }

  const top = map => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const manifestPath = path.join(library, "manifest.json");
  const manifestSize = await pathSize(manifestPath);
  const objectSize = await pathSize(path.join(library, "objects"));
  const librarySize = await pathSize(library);

  return {
    library,
    manifestPath,
    totalPapers: papers.length,
    withDoi,
    withoutDoi,
    withPdf,
    withoutPdf,
    missingPdf,
    uniquePdfObjects: pdfHashCounts.size,
    duplicateDoiValues: Array.from(doiCounts.entries()).filter(([, count]) => count > 1).length,
    duplicatePdfHashes: Array.from(pdfHashCounts.entries()).filter(([, count]) => count > 1).length,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    tagCount: tagCounts.size,
    topTags: top(tagCounts),
    topTypes: top(typeCounts),
    topVenues: top(venueCounts),
    manifestBytes: manifestSize.bytes,
    objectBytes: objectSize.bytes,
    objectFiles: objectSize.files,
    libraryBytes: librarySize.bytes,
  };
}

function printStats(stats) {
  console.log(`Library: ${stats.library}`);
  console.log(`Manifest: ${stats.manifestPath}`);
  console.log("");
  console.log(`Papers: ${stats.totalPapers}`);
  console.log(`With DOI: ${stats.withDoi}`);
  console.log(`Without DOI: ${stats.withoutDoi}`);
  console.log(`With PDF: ${stats.withPdf}`);
  console.log(`Without PDF: ${stats.withoutPdf}`);
  console.log(`Missing stored PDFs: ${stats.missingPdf}`);
  console.log(`Unique PDF objects: ${stats.uniquePdfObjects}`);
  console.log(`Year range: ${stats.yearMin ?? "-"} - ${stats.yearMax ?? "-"}`);
  console.log("");
  console.log(`Manifest size: ${formatBytes(stats.manifestBytes)}`);
  console.log(`Objects size: ${formatBytes(stats.objectBytes)} (${stats.objectFiles} files)`);
  console.log(`Library size: ${formatBytes(stats.libraryBytes)}`);
  console.log("");
  console.log(`Duplicate DOI values: ${stats.duplicateDoiValues}`);
  console.log(`Duplicate PDF hashes: ${stats.duplicatePdfHashes}`);
  if (stats.topTags.length) {
    console.log("");
    console.log("Top tags:");
    for (const item of stats.topTags) console.log(`  ${item.name}: ${item.count}`);
  }
  if (stats.topTypes.length) {
    console.log("");
    console.log("Top types:");
    for (const item of stats.topTypes) console.log(`  ${item.name}: ${item.count}`);
  }
  if (stats.topVenues.length) {
    console.log("");
    console.log("Top venues:");
    for (const item of stats.topVenues) console.log(`  ${item.name}: ${item.count}`);
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const defaultLibrary = defaultLibraryInfo();
  const global = { library: defaultLibrary.path, librarySource: defaultLibrary.source };
  for (let i = 0; i < args.length;) {
    if (args[i] === "--library") {
      global.library = args.splice(i, 2)[1];
      global.librarySource = "--library";
      continue;
    }
    i++;
  }
  global.library = resolvePath(global.library);
  return { global, args };
}

function readOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function readRepeated(args, name) {
  const values = [];
  for (let i = 0; i < args.length;) {
    if (args[i] === name) {
      values.push(args[i + 1]);
      args.splice(i, 2);
      continue;
    }
    i++;
  }
  return values.filter(Boolean);
}

async function queriesFromArgsAndFile(args) {
  const file = readOption(args, "--file");
  const values = [...args];
  if (file) values.push(...await readListFile(file));
  return uniqueValues(values);
}

function zoteroCreatorName(creator) {
  if (creator.name) return creator.name.trim();
  return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
}

function yearFromDate(value) {
  const match = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(value || "");
  return match ? Number(match[1]) : null;
}

function metadataFromZoteroItem(item, zoteroLibrary) {
  const data = item.data || {};
  const doi = data.DOI || data.doi || findDoiInText(data.extra || "");
  if (!doi) return null;
  return {
    doi: normalizeDoi(doi),
    title: data.title || "",
    authors: (data.creators || []).map(zoteroCreatorName).filter(Boolean),
    year: yearFromDate(data.date || ""),
    venue: data.publicationTitle || data.proceedingsTitle || data.bookTitle || "",
    publisher: data.publisher || "",
    url: data.url || "",
    type: data.itemType || "",
    zoteroKey: item.key || data.key,
    zoteroLibrary,
  };
}

async function fetchZoteroJson(baseUrl, zoteroLibrary, apiPath, params = {}) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${zoteroLibrary.replace(/^\/|\/$/g, "")}/${apiPath.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "litvault/0.1" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return { data: await response.json(), total: Number(response.headers.get("Total-Results") || "0") };
}

function attachmentPdfSource(attachment) {
  const data = attachment.data || {};
  if (data.contentType && !data.contentType.toLowerCase().includes("pdf")) return null;
  const p = data.path || "";
  if (p.startsWith("file://")) return decodeURIComponent(new URL(p).pathname);
  if (p && fs.existsSync(expandHome(p))) return expandHome(p);
  const href = attachment.links?.enclosure?.href;
  return href || null;
}

async function downloadPdf(url) {
  const temp = path.join(os.tmpdir(), `litvault-zotero-${process.pid}-${Date.now()}.pdf`);
  const client = url.startsWith("https:") ? https : http;
  await new Promise((resolve, reject) => {
    client.get(url, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(temp);
      response.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    }).on("error", reject);
  });
  return temp;
}

async function findZoteroPdf(baseUrl, zoteroLibrary, itemKey) {
  const { data: children } = await fetchZoteroJson(baseUrl, zoteroLibrary, `items/${itemKey}/children`, {
    format: "json",
    include: "data",
    limit: "100",
  });
  for (const child of children) {
    const source = attachmentPdfSource(child);
    if (!source) continue;
    if (source.startsWith("http://") || source.startsWith("https://")) return downloadPdf(source);
    if (fs.existsSync(source)) return source;
  }
  return null;
}

async function main() {
  const { global, args } = parseArgs(process.argv.slice(2));
  if (args.includes("--help") || args[0] === "-h" || args.length === 0) {
    console.log(usage());
    return 0;
  }
  if (args.includes("--version")) {
    console.log(`litvault ${VERSION}`);
    return 0;
  }

  const command = args.shift();
  const library = global.library;

  if (command === "config") {
    const action = args.shift();
    if (action === "path") {
      console.log(configPath());
      return 0;
    }
    if (action === "get" || !action) {
      const config = readConfig();
      console.log(JSON.stringify({
        configPath: configPath(),
        configuredLibrary: config.library || null,
        effectiveLibrary: global.library,
        effectiveLibrarySource: global.librarySource,
        envLibrary: process.env.LITVAULT_LIBRARY || null,
      }, null, 2));
      return 0;
    }
    if (action === "set") {
      const key = args.shift();
      if (key !== "library") throw new Error("Only config key supported: library");
      const value = args.shift();
      if (!value) throw new Error("Missing library directory.");
      const config = readConfig();
      config.library = resolvePath(value);
      writeConfig(config);
      console.log(`Configured default library: ${config.library}`);
      console.log(`Config: ${configPath()}`);
      return 0;
    }
    if (action === "unset") {
      const key = args.shift();
      if (key !== "library") throw new Error("Only config key supported: library");
      const config = readConfig();
      delete config.library;
      writeConfig(config);
      console.log("Unset default library.");
      console.log(`Config: ${configPath()}`);
      return 0;
    }
    throw new Error(`Unknown config action: ${action}`);
  }

  if (command === "init") {
    const target = path.resolve(expandHome(args[0] || library));
    await ensureLibrary(target);
    console.log(`Initialized litvault library: ${target}`);
    return 0;
  }

  if (command === "add") {
    const doiArg = readOption(args, "--doi");
    const title = readOption(args, "--title", "");
    const tags = readRepeated(args, "--tag");
    const noCrossref = readFlag(args, "--no-crossref");
    const recursive = !readFlag(args, "--no-recursive");
    const quiet = readFlag(args, "--quiet");
    const verbose = readFlag(args, "--verbose");
    if (!args.length) throw new Error("Missing FILE_OR_DIR.");
    if (doiArg && args.length !== 1) throw new Error("--doi can only be used with a single PDF.");
    if (title && args.length !== 1) throw new Error("--title can only be used with a single PDF.");
    const files = await collectPdfPaths(args, recursive);
    if (!files.length) throw new Error("No PDF files found.");
    if (doiArg && files.length !== 1) throw new Error("--doi can only be used with a single PDF, not a directory or batch.");
    if (title && files.length !== 1) throw new Error("--title can only be used with a single PDF, not a directory or batch.");
    const result = await addPdfBatch(library, files, {
      doiArg,
      title,
      tags,
      noCrossref,
      verbose,
      progress: !quiet && !verbose && process.stderr.isTTY,
    });
    console.log(
      `Imported PDFs: ${result.imported}; updated existing records: ${result.updated}; ` +
      `skipped existing PDFs: ${result.skippedExistingPdf}; skipped duplicate input PDFs: ${result.skippedDuplicateInput}; ` +
      `skipped without DOI: ${result.skippedNoDoi}; Library: ${result.library}`
    );
    return result.skippedNoDoi ? 1 : 0;
  }

  if (command === "import-dois") {
    const tags = readRepeated(args, "--tag");
    const noCrossref = readFlag(args, "--no-crossref");
    const queries = await queriesFromArgsAndFile(args);
    const dois = uniqueValues(queries.flatMap(value => findDoisInText(value).length ? findDoisInText(value) : [normalizeDoi(value)]));
    if (!dois.length) throw new Error("Missing DOI values. Pass DOI... or --file dois.txt.");
    let imported = 0;
    let failed = 0;
    for (const doi of dois) {
      try {
        const metadata = await metadataForDoi(doi, "", noCrossref);
        const paper = await upsertPaper(library, metadata, null, tags);
        console.log(`Imported: ${paper.citekey}  DOI: ${paper.doi}`);
        imported++;
      } catch (error) {
        failed++;
        console.error(`Failed: ${doi} (${error.message})`);
      }
    }
    console.log(`Imported DOIs: ${imported}; failed: ${failed}; Library: ${library}`);
    return failed ? 1 : 0;
  }

  if (command === "info") {
    const paper = await findPaper(library, args[0]);
    if (!paper) throw new Error(`No paper matched: ${args[0]}`);
    console.log(JSON.stringify(paper, null, 2));
    return 0;
  }

  if (command === "get") {
    const toArg = readOption(args, "--to");
    const name = readOption(args, "--name", "{citekey}.pdf");
    if (!toArg) throw new Error("Missing --to DIR");
    const to = path.resolve(expandHome(toArg));
    const queries = await queriesFromArgsAndFile(args);
    if (!queries.length) throw new Error("Missing QUERY.");
    await fsp.mkdir(to, { recursive: true });
    let copied = 0;
    let failed = 0;
    for (const query of queries) {
      const paper = await findPaper(library, query);
      if (!paper) {
        failed++;
        console.error(`No paper matched: ${query}`);
        continue;
      }
      if (!paper.pdfPath) {
        failed++;
        console.error(`Paper has no PDF stored: ${query}`);
        continue;
      }
      const source = path.join(library, paper.pdfPath);
      if (!fs.existsSync(source)) {
        failed++;
        console.error(`Stored PDF is missing: ${source}`);
        continue;
      }
      const dest = path.join(to, formatName(name, paper));
      await fsp.copyFile(source, dest);
      console.log(dest);
      copied++;
    }
    console.log(`Copied PDFs: ${copied}; failed: ${failed}`);
    return failed ? 1 : 0;
  }

  if (command === "search") {
    const limit = Number(readOption(args, "--limit", "20"));
    const query = String(args[0] || "").toLowerCase();
    const db = await readDb(library);
    const matches = db.papers
      .filter(p => [p.title, p.doi, p.citekey, p.venue, ...(p.authors || [])].join(" ").toLowerCase().includes(query))
      .sort((a, b) => (b.year || 0) - (a.year || 0) || b.id - a.id)
      .slice(0, limit);
    matches.forEach(printRow);
    if (!matches.length) console.log("No matches.");
    return 0;
  }

  if (command === "list") {
    const limit = Number(readOption(args, "--limit", "50"));
    const db = await readDb(library);
    const rows = [...db.papers].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))).slice(0, limit);
    rows.forEach(printRow);
    if (!rows.length) console.log("No papers yet.");
    return 0;
  }

  if (command === "stats") {
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const stats = await computeStats(library, db);
    if (json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      printStats(stats);
    }
    return 0;
  }

  if (command === "export-bib") {
    const out = readOption(args, "--out");
    const queries = await queriesFromArgsAndFile(args);
    const db = await readDb(library);
    let rows = db.papers;
    if (queries.length) {
      rows = [];
      for (const query of queries) {
        const paper = await findPaper(library, query);
        if (!paper) {
          console.error(`No paper matched: ${query}`);
          continue;
        }
        if (!rows.some(row => row.id === paper.id)) rows.push(paper);
      }
    }
    const text = rows.sort((a, b) => String(a.citekey).localeCompare(String(b.citekey))).map(toBibtex).join("\n\n") + (rows.length ? "\n" : "");
    if (out) {
      const target = path.resolve(expandHome(out));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, text, "utf8");
      console.log(target);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (command === "sync" && args[0] === "zotero") {
    args.shift();
    const baseUrl = readOption(args, "--base-url", "http://localhost:23119/api");
    const zoteroLibrary = readOption(args, "--zotero-library", "users/0").replace(/^\/|\/$/g, "");
    const batchSize = Number(readOption(args, "--batch-size", "100"));
    const tags = readRepeated(args, "--tag");
    const dryRun = readFlag(args, "--dry-run");
    const copyPdfs = !readFlag(args, "--no-copy-pdfs");
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    console.log(`Reading Zotero library: ${baseUrl.replace(/\/$/, "")}/${zoteroLibrary}`);
    for (let start = 0; ; start += batchSize) {
      const { data: items, total } = await fetchZoteroJson(baseUrl, zoteroLibrary, "items/top", {
        format: "json",
        include: "data",
        limit: String(batchSize),
        start: String(start),
      });
      if (!items.length) break;
      for (const item of items) {
        const metadata = metadataFromZoteroItem(item, zoteroLibrary);
        if (!metadata) {
          skipped++;
          continue;
        }
        let pdf = null;
        try {
          if (copyPdfs && metadata.zoteroKey) pdf = await findZoteroPdf(baseUrl, zoteroLibrary, metadata.zoteroKey);
        } catch (error) {
          errors++;
          console.error(`Warning: could not fetch PDF for Zotero item ${metadata.zoteroKey}: ${error.message}`);
        }
        if (dryRun) {
          console.log(`Would import: ${metadata.doi}  ${metadata.title}`);
        } else {
          const paper = await upsertPaper(library, metadata, pdf, tags.length ? tags : ["zotero"]);
          console.log(`Imported: ${paper.citekey}  DOI: ${paper.doi}`);
        }
        if (pdf && pdf.startsWith(os.tmpdir())) await fsp.rm(pdf, { force: true });
        imported++;
      }
      if (items.length < batchSize || (total && start + items.length >= total)) break;
    }
    console.log(`${dryRun ? "Would import" : "Imported"}: ${imported}; skipped without DOI: ${skipped}; PDF errors: ${errors}`);
    return errors ? 1 : 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`litvault: ${error.message}`);
    process.exit(1);
  });
