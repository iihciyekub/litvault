#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const VERSION = "0.1.12";
const FALLBACK_LIBRARY = path.join(os.homedir(), "litvault-library");
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i;
const DOI_GLOBAL_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi;
const STRICT_DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
const DOI_METADATA_PATTERNS = [
  /(?:prism:doi|crossmark:DOI|pdfx:doi|dc:identifier|WPS-ARTICLEDOI|\/DOI|\/doi)\s*(?:=|>|\\\(|\()?[^<>\r\n]{0,240}?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi,
];
const DOI_SOURCE_RANK = {
  "input-list": 1,
  "filename": 2,
  "pdf-content": 3,
  "pdf-metadata": 4,
  "zotero": 5,
  "explicit": 6,
};

function usage() {
  return `litvault ${VERSION}

Usage:
  litvault [--library DIR] init [DIR]
  litvault [--library DIR] add FILE_OR_DIR... [--doi DOI] [--title TITLE] [--tag TAG] [--no-crossref] [--no-recursive] [--quiet] [--verbose]
  litvault scan-doi FILE_OR_DIR... [--json] [--no-recursive]
  litvault [--library DIR] import-dois DOI... [--file dois.txt] [--tag TAG] [--no-crossref]
  litvault [--library DIR] get QUERY... [--to DIR] [--file queries.txt] [--name "{citekey}.pdf"]
  litvault [--library DIR] info QUERY
  litvault [--library DIR] search QUERY [--limit N]
  litvault [--library DIR] list [--limit N]
  litvault [--library DIR] stats [--json]
  litvault [--library DIR] verify [--fast] [--json]
  litvault [--library DIR] doctor [--json]
  litvault [--library DIR] repair-doi [--apply] [--json]
  litvault [--library DIR] dedupe [--apply] [--json]
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
  litvault scan-doi ~/Downloads/papers
  litvault import-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
  litvault import-dois --file dois.txt
  litvault stats
  litvault verify
  litvault doctor
  litvault repair-doi --apply
  litvault dedupe --apply
  litvault get 10.1038/s41586-020-2649-2
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

  doi = doi.replace(/\)\/[a-z][a-z0-9_-].*$/i, ")");
  doi = doi.replace(/[ \t\r\n.,;:\]}>]+$/g, "");
  while (doi.endsWith(")") && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) {
    doi = doi.slice(0, -1);
  }

  return doi.toLowerCase();
}

function isValidDoi(value) {
  return STRICT_DOI_RE.test(normalizeDoi(value));
}

function findDoiInText(text) {
  const match = DOI_RE.exec(text || "");
  return match ? normalizeDoi(match[1]) : null;
}

function findDoisInText(text) {
  return Array.from(String(text || "").matchAll(DOI_GLOBAL_RE), match => normalizeDoi(match[1]));
}

function addDoiCandidate(candidates, doi, source, detail = "") {
  const normalized = normalizeDoi(doi);
  if (!normalized || !isValidDoi(normalized)) return;
  if (candidates.some(item => item.doi === normalized && item.source === source)) return;
  candidates.push({ doi: normalized, source, detail });
}

function findMetadataDoisInText(text) {
  const candidates = [];
  for (const pattern of DOI_METADATA_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(text || "").matchAll(pattern)) {
      addDoiCandidate(candidates, match[1], "pdf-metadata", match[0].slice(0, 80));
    }
  }
  return candidates;
}

function findContentDoisInText(text) {
  return findDoisInText(text).map(doi => ({ doi, source: "pdf-content", detail: "" }));
}

async function scanPdfDoiCandidates(file) {
  const candidates = [];
  const seen = new Set();
  const addMany = items => {
    for (const item of items) {
      const key = `${item.source}:${item.doi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(item);
    }
  };

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    let carry = "";
    stream.on("data", chunk => {
      const text = carry + chunk.toString("latin1");
      addMany(findMetadataDoisInText(text));
      if (!candidates.some(item => item.source === "pdf-content")) {
        addMany(findContentDoisInText(text).slice(0, 5));
      }
      carry = text.slice(-4096);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return candidates;
}

function findDoiInFilename(file) {
  const ext = path.extname(file);
  const base = path.basename(file, ext).replace(/\s+\(\d+\)$/g, "");
  const direct = findDoiInText(base);
  if (direct && isValidDoi(direct)) return direct;

  const safeName = /^10[._](\d{4,9})[_-](.+)$/i.exec(base);
  if (!safeName) return null;
  const candidate = normalizeDoi(`10.${safeName[1]}/${safeName[2]}`);
  return isValidDoi(candidate) ? candidate : null;
}

function uniqueDois(items) {
  const dois = Array.from(new Set(items.map(item => item.doi).filter(Boolean)));
  return dois.filter(doi => !dois.some(other => other !== doi && other.startsWith(doi) && other.length > doi.length));
}

async function extractDoiEvidence(file, explicitDoi = null) {
  const candidates = [];
  if (explicitDoi) {
    const doi = normalizeDoi(explicitDoi);
    return isValidDoi(doi)
      ? { status: "ok", doi, source: "explicit", candidates: [{ doi, source: "explicit", detail: "--doi" }] }
      : { status: "no-doi", doi: null, source: null, candidates: [], reason: "Explicit DOI is invalid" };
  }

  candidates.push(...await scanPdfDoiCandidates(file));
  const filenameDoi = findDoiInFilename(file);
  if (filenameDoi) candidates.push({ doi: filenameDoi, source: "filename", detail: path.basename(file) });

  const metadataDois = uniqueDois(candidates.filter(item => item.source === "pdf-metadata"));
  const contentDois = uniqueDois(candidates.filter(item => item.source === "pdf-content"));

  let doi = null;
  let source = null;
  if (metadataDois.length) {
    doi = filenameDoi && metadataDois.includes(filenameDoi) ? filenameDoi : metadataDois[0];
    source = "pdf-metadata";
    const conflictingMetadata = metadataDois.filter(value => value !== doi);
    if (conflictingMetadata.length && !filenameDoi) {
      return { status: "conflict", doi: null, source: null, candidates, reason: "Multiple metadata DOI values" };
    }
  } else if (contentDois.length) {
    doi = contentDois[0];
    source = "pdf-content";
  } else if (filenameDoi) {
    doi = filenameDoi;
    source = "filename";
  }

  if (!doi) return { status: "no-doi", doi: null, source: null, candidates, reason: "No DOI found" };
  if (filenameDoi && filenameDoi !== doi) {
    return { status: "conflict", doi: null, source: null, candidates, reason: "Filename DOI conflicts with PDF DOI" };
  }

  return { status: "ok", doi, source, candidates };
}

async function findDoiInFile(file) {
  const evidence = await extractDoiEvidence(file);
  return evidence.status === "ok" ? evidence.doi : null;
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

function shouldReplaceDoiSource(currentSource, nextSource) {
  return (DOI_SOURCE_RANK[nextSource] || 0) >= (DOI_SOURCE_RANK[currentSource] || 0);
}

function applyDoiEvidenceToPaper(paper, metadata) {
  if (!metadata.doiSource || !shouldReplaceDoiSource(paper.doiSource, metadata.doiSource)) return;
  paper.doiSource = metadata.doiSource;
  paper.doiEvidence = metadata.doiEvidence || {
    source: metadata.doiSource,
    candidates: metadata.doi ? [{ doi: normalizeDoi(metadata.doi), source: metadata.doiSource }] : [],
  };
  paper.doiEvidenceAt = nowIso();
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
  applyDoiEvidenceToPaper(paper, metadata);
  paper.updatedAt = timestamp;

  await writeDb(library, db);
  return paper;
}

function buildDbIndexes(db) {
  const byDoi = new Map();
  const byPdfSha256 = new Map();
  const byZotero = new Map();
  for (const paper of db.papers || []) {
    if (paper.doi) byDoi.set(normalizeDoi(paper.doi), paper);
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
  applyDoiEvidenceToPaper(paper, metadata);
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
  let skippedDoiConflict = 0;
  let explicitDoi = 0;
  let metadataDoi = 0;
  let contentDoi = 0;
  let filenameDoiFallback = 0;
  let processed = 0;
  const progress = makeProgress(files.length, options.progress);
  const state = () => ({ processed, imported, updated, skippedNoDoi, skippedExistingPdf, skippedDuplicateInput, skippedDoiConflict, filenameDoiFallback });
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

    const evidence = await extractDoiEvidence(file, options.doiArg);
    if (evidence.status === "conflict") {
      skippedDoiConflict++;
      processed++;
      log(`Skipping DOI conflict: ${file}  ${evidence.reason}`);
      for (const candidate of evidence.candidates.slice(0, 6)) {
        log(`  candidate ${candidate.source}: ${candidate.doi}`);
      }
      progress.render(state());
      continue;
    }
    if (evidence.status !== "ok") {
      skippedNoDoi++;
      processed++;
      log(`Skipping without DOI: ${file}`);
      progress.render(state());
      continue;
    }
    const doi = evidence.doi;
    if (evidence.source === "explicit") explicitDoi++;
    else if (evidence.source === "pdf-metadata") metadataDoi++;
    else if (evidence.source === "pdf-content") contentDoi++;
    else if (evidence.source === "filename") filenameDoiFallback++;

    let paper = indexes.byDoi.get(doi);
    let metadata = {
      doi,
      title: options.title || "",
      authors: [],
      doiSource: evidence.source,
      doiEvidence: {
        source: evidence.source,
        candidates: evidence.candidates.map(item => ({
          doi: item.doi,
          source: item.source,
          detail: item.detail || "",
        })),
      },
    };
    if (!paper || !paper.title || !paper.authors?.length || !paper.year) {
      metadata = {
        ...metadata,
        ...(await metadataForDoi(doi, options.title || "", options.noCrossref)),
        doiSource: metadata.doiSource,
        doiEvidence: metadata.doiEvidence,
      };
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
    skippedDoiConflict,
    explicitDoi,
    metadataDoi,
    contentDoi,
    filenameDoiFallback,
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

function printDoiScanResults(results) {
  for (const result of results) {
    console.log(result.file);
    if (result.status === "ok") {
      console.log(`  DOI: ${result.doi}`);
      console.log(`  Source: ${result.source}`);
    } else {
      console.log(`  Status: ${result.status}`);
      if (result.reason) console.log(`  Reason: ${result.reason}`);
    }
    if (result.candidates?.length) {
      console.log("  Candidates:");
      for (const candidate of result.candidates.slice(0, 8)) {
        console.log(`    ${candidate.source}: ${candidate.doi}`);
      }
    }
  }
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

async function collectFiles(root, predicate = () => true) {
  if (!fs.existsSync(root)) return [];
  const stat = await fsp.stat(root);
  if (stat.isFile()) return predicate(root) ? [root] : [];
  if (!stat.isDirectory()) return [];
  const found = [];
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await collectFiles(child, predicate));
    } else if (entry.isFile() && predicate(child)) {
      found.push(child);
    }
  }
  return found;
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
    const skipped = (state.skippedExistingPdf || 0) + (state.skippedDuplicateInput || 0) + (state.skippedNoDoi || 0) + (state.skippedDoiConflict || 0);
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
  return db.papers.find(p => p.doi && normalizeDoi(p.doi) === normalized)
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
  const doiSourceCounts = new Map();

  for (const paper of papers) {
    for (const tag of paper.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    if (paper.type) typeCounts.set(paper.type, (typeCounts.get(paper.type) || 0) + 1);
    if (paper.venue) venueCounts.set(paper.venue, (venueCounts.get(paper.venue) || 0) + 1);
    if (paper.doi) {
      const normalizedDoi = normalizeDoi(paper.doi);
      doiCounts.set(normalizedDoi, (doiCounts.get(normalizedDoi) || 0) + 1);
    }
    if (paper.pdfSha256) pdfHashCounts.set(paper.pdfSha256, (pdfHashCounts.get(paper.pdfSha256) || 0) + 1);
    if (paper.doiSource) doiSourceCounts.set(paper.doiSource, (doiSourceCounts.get(paper.doiSource) || 0) + 1);
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
    doiSources: top(doiSourceCounts),
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
  if (stats.doiSources.length) {
    console.log("");
    console.log("DOI sources:");
    for (const item of stats.doiSources) console.log(`  ${item.name}: ${item.count}`);
  }
}

async function verifyLibrary(library, db, options = {}) {
  const papers = db.papers || [];
  const referencedPaths = new Set();
  const missingPdfRecords = [];
  const hashMismatches = [];
  const verifiedPdfRecords = [];

  for (const paper of papers) {
    if (!paper.pdfPath) continue;
    const absolute = path.join(library, paper.pdfPath);
    referencedPaths.add(path.normalize(paper.pdfPath));
    if (!fs.existsSync(absolute)) {
      missingPdfRecords.push(paperBrief(paper));
      continue;
    }
    if (!options.fast && paper.pdfSha256) {
      const actual = await sha256File(absolute);
      if (actual !== paper.pdfSha256) {
        hashMismatches.push({
          record: paperBrief(paper),
          expected: paper.pdfSha256,
          actual,
        });
      } else {
        verifiedPdfRecords.push(paperBrief(paper));
      }
    }
  }

  const objectsRoot = path.join(library, "objects");
  const objectFiles = await collectFiles(objectsRoot, file => file.toLowerCase().endsWith(".pdf"));
  const orphanObjects = objectFiles
    .map(file => path.relative(library, file))
    .filter(rel => !referencedPaths.has(path.normalize(rel)))
    .sort();
  const doiRepairPlan = planRepairDoi(db);
  const duplicatePdfHashGroups = duplicatePdfGroups(db);
  const duplicateDoiGroups = duplicateGroupsBy(papers, paper => paper.doi ? normalizeDoi(paper.doi) : null);

  const ok = missingPdfRecords.length === 0
    && hashMismatches.length === 0
    && orphanObjects.length === 0
    && doiRepairPlan.normalize.length === 0
    && doiRepairPlan.clear.length === 0
    && duplicatePdfHashGroups.length === 0
    && duplicateDoiGroups.length === 0;

  return {
    ok,
    fast: Boolean(options.fast),
    library,
    totalPapers: papers.length,
    recordsWithPdf: papers.filter(paper => paper.pdfPath).length,
    checkedHashes: options.fast ? 0 : verifiedPdfRecords.length + hashMismatches.length,
    missingPdfRecords,
    hashMismatches,
    orphanObjects,
    objectFiles: objectFiles.length,
    duplicatePdfHashGroups: duplicatePdfHashGroups.length,
    duplicateDoiGroups: duplicateDoiGroups.length,
    normalizableDoiValues: doiRepairPlan.normalize.length,
    invalidDoiValues: doiRepairPlan.clear.length,
  };
}

function printVerifyReport(report) {
  console.log(`Integrity: ${report.ok ? "OK" : "FAILED"}`);
  console.log(`Library: ${report.library}`);
  console.log("");
  console.log(`Papers: ${report.totalPapers}`);
  console.log(`Records with PDF: ${report.recordsWithPdf}`);
  console.log(`Object PDFs: ${report.objectFiles}`);
  console.log(`Checked hashes: ${report.checkedHashes}${report.fast ? " (fast mode skipped hashing)" : ""}`);
  console.log("");
  console.log(`Missing referenced PDFs: ${report.missingPdfRecords.length}`);
  console.log(`Hash mismatches: ${report.hashMismatches.length}`);
  console.log(`Orphan object PDFs: ${report.orphanObjects.length}`);
  console.log(`Duplicate PDF hash groups: ${report.duplicatePdfHashGroups}`);
  console.log(`Duplicate DOI groups: ${report.duplicateDoiGroups}`);
  console.log(`Normalizable DOI values: ${report.normalizableDoiValues}`);
  console.log(`Invalid DOI values: ${report.invalidDoiValues}`);

  if (report.missingPdfRecords.length) {
    console.log("");
    console.log("Missing PDF preview:");
    for (const record of report.missingPdfRecords.slice(0, 10)) {
      console.log(`  #${record.id} ${record.doi || "-"} ${record.pdfPath || "-"}`);
    }
  }
  if (report.hashMismatches.length) {
    console.log("");
    console.log("Hash mismatch preview:");
    for (const item of report.hashMismatches.slice(0, 10)) {
      console.log(`  #${item.record.id} expected ${item.expected.slice(0, 12)}... actual ${item.actual.slice(0, 12)}...`);
    }
  }
  if (report.orphanObjects.length) {
    console.log("");
    console.log("Orphan object preview:");
    for (const rel of report.orphanObjects.slice(0, 10)) console.log(`  ${rel}`);
  }
}

function paperBrief(paper) {
  return {
    id: paper.id,
    doi: paper.doi ? normalizeDoi(paper.doi) : null,
    doiSource: paper.doiSource || null,
    citekey: paper.citekey || null,
    title: paper.title || "",
    year: paper.year || null,
    pdfSha256: paper.pdfSha256 || null,
    pdfPath: paper.pdfPath || null,
  };
}

function metadataScore(paper) {
  let score = 0;
  if (paper.doi) score += 5;
  if (paper.title) score += Math.min(10, Math.ceil(String(paper.title).length / 12));
  if (paper.authors?.length) score += Math.min(8, paper.authors.length * 2);
  if (paper.year) score += 3;
  if (paper.venue) score += 3;
  if (paper.publisher) score += 1;
  if (paper.url) score += 1;
  if (paper.type) score += 1;
  if (paper.pdfPath) score += 2;
  return score;
}

function duplicateGroupsBy(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return Array.from(groups.entries())
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, items }));
}

function duplicatePdfGroups(db) {
  return duplicateGroupsBy(db.papers || [], paper => paper.pdfSha256)
    .map(group => {
      const doiValues = uniqueValues(group.items.map(paper => paper.doi ? normalizeDoi(paper.doi) : null).filter(Boolean));
      return {
        pdfSha256: group.key,
        safeToMerge: doiValues.length <= 1,
        reason: doiValues.length <= 1 ? "same PDF hash with compatible DOI values" : "same PDF hash has multiple DOI values",
        doiValues,
        records: group.items
          .slice()
          .sort((a, b) => a.id - b.id)
          .map(paperBrief),
      };
    })
    .sort((a, b) => b.records.length - a.records.length || a.pdfSha256.localeCompare(b.pdfSha256));
}

function planRepairDoi(db) {
  const normalize = [];
  const clear = [];
  for (const paper of db.papers || []) {
    if (!paper.doi) continue;
    const raw = String(paper.doi);
    const normalized = normalizeDoi(raw);
    if (normalized && isValidDoi(normalized)) {
      if (raw !== normalized) {
        normalize.push({
          record: paperBrief(paper),
          from: raw,
          to: normalized,
        });
      }
    } else {
      clear.push({
        record: paperBrief(paper),
        from: raw,
        to: null,
      });
    }
  }
  return { normalize, clear };
}

async function applyRepairDoi(library, db, plan) {
  const byId = new Map((db.papers || []).map(paper => [paper.id, paper]));
  let normalized = 0;
  let cleared = 0;
  for (const item of plan.normalize) {
    const paper = byId.get(item.record.id);
    if (!paper) continue;
    paper.doi = item.to;
    paper.updatedAt = nowIso();
    normalized++;
  }
  for (const item of plan.clear) {
    const paper = byId.get(item.record.id);
    if (!paper) continue;
    paper.doi = null;
    paper.updatedAt = nowIso();
    cleared++;
  }
  let backup = null;
  if (normalized || cleared) {
    backup = await backupManifest(library);
    await writeDb(library, db);
  }
  return { backup, normalized, cleared };
}

function printRepairDoiPlan(plan, applied = null) {
  console.log(`Normalizable DOI values: ${plan.normalize.length}`);
  console.log(`Invalid DOI values to clear: ${plan.clear.length}`);
  if (applied) {
    console.log(`Applied: normalized ${applied.normalized}; cleared ${applied.cleared}`);
    if (applied.backup) console.log(`Backup: ${applied.backup}`);
  } else {
    console.log("Dry run: no changes written. Use --apply to normalize valid DOI values and clear invalid DOI values.");
  }

  if (plan.normalize.length) {
    console.log("");
    console.log("Normalize preview:");
    for (const item of plan.normalize.slice(0, 10)) {
      console.log(`  #${item.record.id} ${item.from} -> ${item.to}`);
    }
    if (plan.normalize.length > 10) console.log(`  ... ${plan.normalize.length - 10} more records`);
  }
  if (plan.clear.length) {
    console.log("");
    console.log("Clear preview:");
    for (const item of plan.clear.slice(0, 10)) {
      console.log(`  #${item.record.id} ${item.from}`);
    }
    if (plan.clear.length > 10) console.log(`  ... ${plan.clear.length - 10} more records`);
  }
}

function buildDoctorReport(library, db) {
  const papers = db.papers || [];
  const duplicatePdfHashGroups = duplicatePdfGroups(db);
  const duplicateDoiGroups = duplicateGroupsBy(papers, paper => paper.doi ? normalizeDoi(paper.doi) : null)
    .map(group => ({
      doi: group.key,
      records: group.items.slice().sort((a, b) => a.id - b.id).map(paperBrief),
    }));
  const missingPdfRecords = papers
    .filter(paper => paper.pdfPath && !fs.existsSync(path.join(library, paper.pdfPath)))
    .map(paperBrief);
  const recordsWithoutPdf = papers.filter(paper => !paper.pdfPath).map(paperBrief);
  const recordsWithoutDoi = papers.filter(paper => !paper.doi).map(paperBrief);
  const doiRepairPlan = planRepairDoi(db);
  const recordsMissingMetadata = papers
    .filter(paper => !paper.title || !paper.year || !paper.authors?.length)
    .map(paperBrief);

  return {
    library,
    totalPapers: papers.length,
    duplicatePdfHashGroups,
    safeDuplicatePdfHashGroups: duplicatePdfHashGroups.filter(group => group.safeToMerge),
    conflictDuplicatePdfHashGroups: duplicatePdfHashGroups.filter(group => !group.safeToMerge),
    duplicateDoiGroups,
    missingPdfRecords,
    recordsWithoutPdf,
    recordsWithoutDoi,
    normalizableDoiRecords: doiRepairPlan.normalize,
    invalidDoiRecords: doiRepairPlan.clear,
    recordsMissingMetadata,
  };
}

function printDoctorReport(report) {
  console.log(`Library: ${report.library}`);
  console.log(`Papers: ${report.totalPapers}`);
  console.log("");
  console.log(`Duplicate PDF hash groups: ${report.duplicatePdfHashGroups.length}`);
  console.log(`  Safe to merge: ${report.safeDuplicatePdfHashGroups.length}`);
  console.log(`  Conflicts: ${report.conflictDuplicatePdfHashGroups.length}`);
  console.log(`Duplicate DOI groups: ${report.duplicateDoiGroups.length}`);
  console.log(`Missing stored PDFs: ${report.missingPdfRecords.length}`);
  console.log(`Records without PDF: ${report.recordsWithoutPdf.length}`);
  console.log(`Records without DOI: ${report.recordsWithoutDoi.length}`);
  console.log(`Normalizable DOI values: ${report.normalizableDoiRecords.length}`);
  console.log(`Invalid DOI values: ${report.invalidDoiRecords.length}`);
  console.log(`Records missing title/year/authors: ${report.recordsMissingMetadata.length}`);

  const previewGroups = report.duplicatePdfHashGroups.slice(0, 10);
  if (previewGroups.length) {
    console.log("");
    console.log("Duplicate PDF hash preview:");
    for (const group of previewGroups) {
      console.log(`  ${group.pdfSha256.slice(0, 12)}... (${group.records.length} records) ${group.safeToMerge ? "safe" : "conflict"}`);
      for (const record of group.records.slice(0, 5)) {
        console.log(`    #${record.id} ${record.doi || "-"} ${record.citekey || "-"} ${record.title || ""}`.trimEnd());
      }
    }
    if (report.duplicatePdfHashGroups.length > previewGroups.length) {
      console.log(`  ... ${report.duplicatePdfHashGroups.length - previewGroups.length} more groups`);
    }
  }
}

function mergeRecordIntoCanonical(canonical, duplicate) {
  canonical.doi = canonical.doi || duplicate.doi || null;
  if (canonical.doi) canonical.doi = normalizeDoi(canonical.doi);
  canonical.title = canonical.title || duplicate.title || "";
  canonical.authors = canonical.authors?.length ? canonical.authors : duplicate.authors || [];
  canonical.year = canonical.year || duplicate.year || null;
  canonical.venue = canonical.venue || duplicate.venue || "";
  canonical.publisher = canonical.publisher || duplicate.publisher || "";
  canonical.url = canonical.url || duplicate.url || "";
  canonical.type = canonical.type || duplicate.type || "";
  canonical.citekey = canonical.citekey || duplicate.citekey || null;
  canonical.pdfSha256 = canonical.pdfSha256 || duplicate.pdfSha256 || null;
  canonical.pdfPath = canonical.pdfPath || duplicate.pdfPath || null;
  canonical.tags = Array.from(new Set([...(canonical.tags || []), ...(duplicate.tags || [])])).sort();
  canonical.zoteroKey = canonical.zoteroKey || duplicate.zoteroKey || null;
  canonical.zoteroLibrary = canonical.zoteroLibrary || duplicate.zoteroLibrary || null;
  canonical.updatedAt = nowIso();
}

function chooseCanonical(records) {
  return records
    .slice()
    .sort((a, b) => metadataScore(b) - metadataScore(a) || a.id - b.id)[0];
}

function planDedupe(db) {
  const groups = duplicatePdfGroups(db);
  const safeGroups = groups.filter(group => group.safeToMerge);
  const conflictGroups = groups.filter(group => !group.safeToMerge);
  const byId = new Map((db.papers || []).map(paper => [paper.id, paper]));
  const mergePlans = [];

  for (const group of safeGroups) {
    const records = group.records.map(record => byId.get(record.id)).filter(Boolean);
    const canonical = chooseCanonical(records);
    const duplicateRecords = records.filter(record => record.id !== canonical.id);
    mergePlans.push({
      pdfSha256: group.pdfSha256,
      canonical: paperBrief(canonical),
      remove: duplicateRecords.map(paperBrief),
      mergedRecordIds: duplicateRecords.map(record => record.id),
    });
  }

  return {
    safeGroups: safeGroups.length,
    conflictGroups: conflictGroups.length,
    mergePlans,
    conflictPreview: conflictGroups.slice(0, 10),
  };
}

async function backupManifest(library) {
  const manifest = path.join(library, "manifest.json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(library, `manifest.backup-${stamp}.json`);
  await fsp.copyFile(manifest, backup);
  return backup;
}

async function applyDedupe(library, db, plan) {
  const byId = new Map((db.papers || []).map(paper => [paper.id, paper]));
  const removeIds = new Set();
  for (const mergePlan of plan.mergePlans) {
    const canonical = byId.get(mergePlan.canonical.id);
    if (!canonical) continue;
    for (const remove of mergePlan.remove) {
      const duplicate = byId.get(remove.id);
      if (!duplicate) continue;
      mergeRecordIntoCanonical(canonical, duplicate);
      removeIds.add(duplicate.id);
    }
  }
  db.papers = (db.papers || []).filter(paper => !removeIds.has(paper.id));
  const backup = await backupManifest(library);
  await writeDb(library, db);
  return { backup, removedRecords: removeIds.size };
}

function printDedupePlan(plan, applied = null) {
  console.log(`Safe duplicate PDF groups: ${plan.safeGroups}`);
  console.log(`Conflict duplicate PDF groups: ${plan.conflictGroups}`);
  console.log(`Records that would be removed: ${plan.mergePlans.reduce((sum, item) => sum + item.remove.length, 0)}`);
  if (applied) {
    console.log(`Applied: removed ${applied.removedRecords} records`);
    console.log(`Backup: ${applied.backup}`);
  } else {
    console.log("Dry run: no changes written. Use --apply to merge safe groups.");
  }

  if (plan.mergePlans.length) {
    console.log("");
    console.log("Safe merge preview:");
    for (const item of plan.mergePlans.slice(0, 10)) {
      console.log(`  keep #${item.canonical.id} ${item.canonical.doi || "-"} ${item.canonical.citekey || "-"}`);
      console.log(`    remove: ${item.remove.map(record => `#${record.id}`).join(", ")}`);
    }
    if (plan.mergePlans.length > 10) console.log(`  ... ${plan.mergePlans.length - 10} more groups`);
  }

  if (plan.conflictPreview.length) {
    console.log("");
    console.log("Conflict preview, not auto-merged:");
    for (const group of plan.conflictPreview) {
      console.log(`  ${group.pdfSha256.slice(0, 12)}... DOI values: ${group.doiValues.join(", ")}`);
    }
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
    doiSource: "zotero",
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
      `skipped DOI conflicts: ${result.skippedDoiConflict}; skipped without DOI: ${result.skippedNoDoi}; ` +
      `DOI sources: explicit ${result.explicitDoi}, metadata ${result.metadataDoi}, content ${result.contentDoi}, filename ${result.filenameDoiFallback}; ` +
      `Library: ${result.library}`
    );
    return result.skippedNoDoi || result.skippedDoiConflict ? 1 : 0;
  }

  if (command === "scan-doi") {
    const json = readFlag(args, "--json");
    const recursive = !readFlag(args, "--no-recursive");
    if (!args.length) throw new Error("Missing FILE_OR_DIR.");
    const files = await collectPdfPaths(args, recursive);
    if (!files.length) throw new Error("No PDF files found.");
    const results = [];
    for (const file of files) {
      const evidence = await extractDoiEvidence(file);
      results.push({
        file,
        status: evidence.status,
        doi: evidence.doi || null,
        source: evidence.source || null,
        reason: evidence.reason || null,
        candidates: evidence.candidates.map(item => ({
          doi: item.doi,
          source: item.source,
          detail: item.detail || "",
        })),
      });
    }
    if (json) console.log(JSON.stringify(results, null, 2));
    else printDoiScanResults(results);
    return results.some(result => result.status === "conflict") ? 2 : results.some(result => result.status !== "ok") ? 1 : 0;
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
        const metadata = {
          ...(await metadataForDoi(doi, "", noCrossref)),
          doiSource: "input-list",
        };
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
    const to = toArg ? path.resolve(expandHome(toArg)) : process.cwd();
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

  if (command === "verify") {
    const json = readFlag(args, "--json");
    const fast = readFlag(args, "--fast");
    const db = await readDb(library);
    const report = await verifyLibrary(library, db, { fast });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printVerifyReport(report);
    }
    return report.ok ? 0 : 1;
  }

  if (command === "doctor") {
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const report = buildDoctorReport(library, db);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printDoctorReport(report);
    }
    return 0;
  }

  if (command === "repair-doi") {
    const apply = readFlag(args, "--apply");
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const plan = planRepairDoi(db);
    let applied = null;
    if (apply) {
      applied = await applyRepairDoi(library, db, plan);
    }
    if (json) {
      console.log(JSON.stringify({ plan, applied }, null, 2));
    } else {
      printRepairDoiPlan(plan, applied);
    }
    return 0;
  }

  if (command === "dedupe") {
    const apply = readFlag(args, "--apply");
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const plan = planDedupe(db);
    let applied = null;
    if (apply) {
      applied = await applyDedupe(library, db, plan);
    }
    if (json) {
      console.log(JSON.stringify({ plan, applied }, null, 2));
    } else {
      printDedupePlan(plan, applied);
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
