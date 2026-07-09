#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const VERSION = "0.1.24";
const GITHUB_REPO = "iihciyekub/litvault";
const FALLBACK_LIBRARY = path.join("/Volumes", "REFSSD", "litvault-library");
const DEFAULT_CROSSREF_DELAY_MS = 250;
const DEFAULT_CROSSREF_RETRIES = 3;
const DOI_SUFFIX_RE_SOURCE = String.raw`[-._;()/:,A-Z0-9+%<>=]+`;
const DOI_RE = new RegExp(String.raw`\b(10\.\d{4,9}/${DOI_SUFFIX_RE_SOURCE})`, "i");
const DOI_GLOBAL_RE = new RegExp(String.raw`\b(10\.\d{4,9}/${DOI_SUFFIX_RE_SOURCE})`, "gi");
const STRICT_DOI_RE = new RegExp(String.raw`^10\.\d{4,9}/${DOI_SUFFIX_RE_SOURCE}$`, "i");
const DOI_METADATA_PATTERNS = [
  /(?:prism:doi|crossmark:DOI|pdfx:doi|dc:identifier|WPS-ARTICLEDOI|\/DOI|\/doi)\s*(?:=|>|\\\(|\()?[^<>\r\n]{0,240}?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/gi,
];
const DOI_SOURCE_RANK = {
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
  litvault [--library DIR] add FILE_OR_DIR... [--doi DOI] [--title TITLE] [--tag TAG] [--no-crossref] [--crossref-delay MS] [--crossref-retries N] [--no-recursive] [--quiet] [--verbose]
  litvault scan-doi FILE_OR_DIR... [--json] [--no-recursive]
  litvault [--library DIR] missing-dois DOI... [--file dois.txt] [--json]
  litvault [--library DIR] get QUERY... [--to DIR] [--file queries.txt] [--name "{citekey}.pdf"]
  litvault [--library DIR] info QUERY
  litvault [--library DIR] search QUERY [--limit N]
  litvault [--library DIR] list [--limit N]
  litvault [--library DIR] stats [--json]
  litvault [--library DIR] verify [--fast] [--json]
  litvault [--library DIR] backup list [--json]
  litvault [--library DIR] backup prune [--keep N] [--apply] [--json]
  litvault [--library DIR] doctor [--json]
  litvault [--library DIR] prune-invalid-pdfs [--apply] [--json]
  litvault [--library DIR] repair-metadata [--apply] [--json] [--no-crossref] [--crossref-delay MS] [--crossref-retries N]
  litvault [--library DIR] repair-doi [--apply] [--json]
  litvault [--library DIR] dedupe-doi [--apply] [--json] [--keep ID --remove ID...] [--delete-extra-pdfs]
  litvault [--library DIR] dedupe [--apply] [--json]
  litvault [--library DIR] export-bib [QUERY...] [--file queries.txt] [--out FILE]
  litvault update [--check] [--dry-run] [--force] [--ref REF]
  litvault config get
  litvault config set library DIR
  litvault config unset library
  litvault config path

Examples:
  litvault init
  litvault config set library /Volumes/REFSSD/litvault-library
  litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
  litvault add ~/Downloads/papers
  litvault scan-doi ~/Downloads/papers
  litvault missing-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
  litvault missing-dois --file dois.txt
  litvault stats
  litvault verify
  litvault backup list
  litvault backup prune --keep 20
  litvault doctor
  litvault prune-invalid-pdfs
  litvault repair-metadata --apply
  litvault repair-doi --apply
  litvault dedupe-doi
  litvault dedupe --apply
  litvault get 10.1038/s41586-020-2649-2
  litvault get 10.1038/s41586-020-2649-2 10.1145/3510003.3510101 --to ~/Desktop/refs
  litvault get --file dois.txt --to ~/Desktop/refs
  litvault export-bib 10.1038/s41586-020-2649-2 --out refs.bib
  litvault update
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

  doi = doi.replace(/<\/[a-z][^>\s]*.*$/i, "");
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

function doiLooseKey(value) {
  return normalizeDoi(value).replace(/[^a-z0-9]+/gi, "");
}

function doiMatchesFilenameCandidate(filenameDoi, doi) {
  return normalizeDoi(filenameDoi) === normalizeDoi(doi) || doiLooseKey(filenameDoi) === doiLooseKey(doi);
}

function findDoiInText(text) {
  const match = DOI_RE.exec(text || "");
  return match ? normalizeDoi(match[1]) : null;
}

function findDoisInText(text) {
  return Array.from(String(text || "").matchAll(DOI_GLOBAL_RE), match => normalizeDoi(match[1]));
}

function looksLikeDoiInput(value) {
  const text = String(value || "").trim();
  return /^10\./i.test(text)
    || /^doi\s*[:=]/i.test(text)
    || /^https?:\/\/(?:dx\.)?doi\.org\//i.test(text);
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

function bytesLiteral(buffer) {
  let text = "b'";
  for (const byte of buffer) {
    if (byte === 0x5c) text += "\\\\";
    else if (byte === 0x27) text += "\\'";
    else if (byte === 0x0a) text += "\\n";
    else if (byte === 0x0d) text += "\\r";
    else if (byte === 0x09) text += "\\t";
    else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte);
    else text += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${text}'`;
}

async function inspectPdfFile(file) {
  const fd = await fsp.open(file, "r");
  try {
    const stat = await fd.stat();
    const headLength = Math.min(1024, stat.size);
    const tailLength = Math.min(65536, stat.size);
    const head = Buffer.alloc(headLength);
    const tail = Buffer.alloc(tailLength);
    if (headLength) await fd.read(head, 0, headLength, 0);
    if (tailLength) await fd.read(tail, 0, tailLength, stat.size - tailLength);

    const headText = head.toString("latin1");
    const tailText = tail.toString("latin1");
    const headerOffset = headText.indexOf("%PDF-");
    const hasPdfHeader = headerOffset !== -1;
    const hasEofMarker = tailText.includes("%%EOF");
    const issues = [];
    if (!hasPdfHeader) issues.push(`invalid pdf header: ${bytesLiteral(head.slice(0, 5))}`);
    if (!hasEofMarker) issues.push("EOF marker not found");

    return {
      ok: issues.length === 0,
      file,
      bytes: stat.size,
      headerPreview: bytesLiteral(head.slice(0, 5)),
      hasPdfHeader,
      headerOffset: hasPdfHeader ? headerOffset : null,
      hasEofMarker,
      reason: issues[0] || null,
      issues,
    };
  } finally {
    await fd.close();
  }
}

function scanPdfVisibleTextDoiCandidates(file) {
  const result = spawnSync("pdftotext", ["-f", "1", "-l", "3", file, "-"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return findDoisInText(result.stdout).map(doi => ({ doi, source: "pdf-content", detail: "pdftotext" }));
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

function sourceForDoi(candidates, doi, preferredSources = []) {
  const matching = candidates.filter(item => item.doi === doi);
  for (const source of preferredSources) {
    if (matching.some(item => item.source === source)) return source;
  }
  return matching[0]?.source || null;
}

async function extractDoiEvidence(file, explicitDoi = null) {
  const pdfInspection = await inspectPdfFile(file);
  if (!pdfInspection.ok) {
    return {
      status: "invalid-pdf",
      doi: null,
      source: null,
      candidates: [],
      reason: pdfInspection.reason,
      pdfInspection,
    };
  }

  const candidates = [];
  if (explicitDoi) {
    const doi = normalizeDoi(explicitDoi);
    return isValidDoi(doi)
      ? { status: "ok", doi, source: "explicit", candidates: [{ doi, source: "explicit", detail: "--doi" }] }
      : { status: "no-doi", doi: null, source: null, candidates: [], reason: "Explicit DOI is invalid" };
  }

  candidates.push(...scanPdfVisibleTextDoiCandidates(file));
  candidates.push(...await scanPdfDoiCandidates(file));
  const filenameDoi = findDoiInFilename(file);
  if (filenameDoi) candidates.push({ doi: filenameDoi, source: "filename", detail: path.basename(file) });

  const metadataDois = uniqueDois(candidates.filter(item => item.source === "pdf-metadata"));
  const contentDois = uniqueDois(candidates.filter(item => item.source === "pdf-content"));
  const pdfDois = uniqueDois(candidates.filter(item => item.source === "pdf-content" || item.source === "pdf-metadata"));
  const filenameMatchedPdfDoi = filenameDoi
    ? pdfDois.find(candidate => doiMatchesFilenameCandidate(filenameDoi, candidate))
    : null;

  let doi = null;
  let source = null;
  if (filenameMatchedPdfDoi) {
    doi = filenameMatchedPdfDoi;
    source = sourceForDoi(candidates, doi, ["pdf-content", "pdf-metadata"]);
  } else if (contentDois.length) {
    if (contentDois.length > 1 && !filenameDoi) {
      return { status: "conflict", doi: null, source: null, candidates, reason: "Multiple PDF content DOI values" };
    }
    doi = contentDois.length === 1 ? contentDois[0] : filenameDoi;
    source = contentDois.length === 1
      ? (metadataDois.includes(doi) ? "pdf-metadata" : "pdf-content")
      : "filename";
  } else if (metadataDois.length) {
    if (metadataDois.length > 1) {
      if (!filenameDoi) {
        return { status: "conflict", doi: null, source: null, candidates, reason: "Multiple metadata DOI values" };
      }
      doi = filenameDoi;
      source = "filename";
    } else {
      doi = metadataDois[0];
      source = "pdf-metadata";
    }
  } else if (filenameDoi) {
    doi = filenameDoi;
    source = "filename";
  }

  if (!doi) return { status: "no-doi", doi: null, source: null, candidates, reason: "No DOI found" };
  if (filenameDoi && !doiMatchesFilenameCandidate(filenameDoi, doi)) {
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "litvault/0.1",
    },
  });
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function crossrefRetryDelay(delayMs, attempt) {
  if (!delayMs) return 0;
  const factors = [1, 2, 5];
  return delayMs * (factors[attempt - 1] || factors[factors.length - 1]);
}

function shouldRetryCrossref(error) {
  if (error?.status === 429) return true;
  if (error?.status >= 500) return true;
  if (!error?.status && /fetch failed|network|timeout|terminated|socket|econnreset|etimedout/i.test(error?.message || "")) return true;
  return false;
}

function createCrossrefClient(options = {}) {
  const delayMs = Math.max(0, Number(options.delayMs ?? DEFAULT_CROSSREF_DELAY_MS));
  const retries = Math.max(0, Math.floor(Number(options.retries ?? DEFAULT_CROSSREF_RETRIES)));
  let lastRequestStartedAt = 0;

  async function waitForTurn() {
    if (!delayMs || !lastRequestStartedAt) return;
    const elapsed = Date.now() - lastRequestStartedAt;
    if (elapsed < delayMs) await sleep(delayMs - elapsed);
  }

  async function fetchJsonWithRetry(url, label = "Crossref") {
    for (let attempt = 0; ; attempt++) {
      await waitForTurn();
      lastRequestStartedAt = Date.now();
      try {
        return await fetchJson(url);
      } catch (error) {
        if (attempt >= retries || !shouldRetryCrossref(error)) throw error;
        const waitMs = crossrefRetryDelay(delayMs || DEFAULT_CROSSREF_DELAY_MS, attempt + 1);
        console.error(`Warning: ${label} retry ${attempt + 1}/${retries} after ${waitMs}ms (${error.message})`);
        if (waitMs) await sleep(waitMs);
      }
    }
  }

  return { delayMs, retries, fetchJson: fetchJsonWithRetry };
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

async function fetchCrossref(doi, crossref = createCrossrefClient()) {
  const encoded = encodeURIComponent(doi);
  const payload = await crossref.fetchJson(`https://api.crossref.org/works/${encoded}`, `Crossref ${doi}`);
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

async function metadataForDoi(doi, title = "", noCrossref = false, crossref = createCrossrefClient()) {
  let metadata = { doi: normalizeDoi(doi), title, authors: [] };
  if (!noCrossref) {
    try {
      metadata = { ...metadata, ...(await fetchCrossref(metadata.doi, crossref)) };
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
  if (!pdfData?.sha256 || !pdfData?.path) {
    throw new Error("Cannot create or update a paper record without a stored PDF.");
  }
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
  const crossref = createCrossrefClient(options.crossref);
  const seenInputHashes = new Map();
  let imported = 0;
  let updated = 0;
  let skippedNoDoi = 0;
  let skippedExistingPdf = 0;
  let skippedDuplicateInput = 0;
  let skippedDoiConflict = 0;
  let skippedInvalidPdf = 0;
  let explicitDoi = 0;
  let metadataDoi = 0;
  let contentDoi = 0;
  let filenameDoiFallback = 0;
  let processed = 0;
  const progress = makeProgress(files.length, options.progress);
  const state = () => ({ processed, imported, updated, skippedNoDoi, skippedExistingPdf, skippedDuplicateInput, skippedDoiConflict, skippedInvalidPdf, filenameDoiFallback });
  const log = message => {
    if (options.verbose) console.log(message);
  };
  progress.render(state());

  for (const file of files) {
    const pdfInspection = await inspectPdfFile(file);
    if (!pdfInspection.ok) {
      skippedInvalidPdf++;
      processed++;
      log(`Skipping invalid PDF: ${file}  ${pdfInspection.reason}`);
      progress.render(state());
      continue;
    }

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
        ...(await metadataForDoi(doi, options.title || "", options.noCrossref, crossref)),
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
    skippedInvalidPdf,
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
    const skipped = (state.skippedExistingPdf || 0) + (state.skippedDuplicateInput || 0) + (state.skippedNoDoi || 0) + (state.skippedDoiConflict || 0) + (state.skippedInvalidPdf || 0);
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
  const values = findDoisInText(text);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!findDoisInText(trimmed).length && looksLikeDoiInput(trimmed)) values.push(trimmed);
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
  const invalidPdfRecords = [];
  const verifiedPdfRecords = [];

  for (const paper of papers) {
    if (!paper.pdfPath) continue;
    const absolute = path.join(library, paper.pdfPath);
    referencedPaths.add(path.normalize(paper.pdfPath));
    if (!fs.existsSync(absolute)) {
      missingPdfRecords.push(paperBrief(paper));
      continue;
    }
    const pdfInspection = await inspectPdfFile(absolute);
    if (!pdfInspection.ok) {
      invalidPdfRecords.push({
        record: paperBrief(paper),
        reason: pdfInspection.reason,
        issues: pdfInspection.issues,
        headerPreview: pdfInspection.headerPreview,
      });
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
  const invalidObjectPdfs = [];
  for (const rel of orphanObjects) {
    const pdfInspection = await inspectPdfFile(path.join(library, rel));
    if (!pdfInspection.ok) {
      invalidObjectPdfs.push({
        path: rel,
        reason: pdfInspection.reason,
        issues: pdfInspection.issues,
        headerPreview: pdfInspection.headerPreview,
      });
    }
  }
  const doiRepairPlan = planRepairDoi(db);
  const duplicatePdfHashGroups = duplicatePdfGroups(db);
  const duplicateDoiGroups = duplicateGroupsBy(papers, paper => paper.doi ? normalizeDoi(paper.doi) : null);
  const recordsWithoutPdf = papers.filter(paper => !paper.pdfPath).map(paperBrief);

  const ok = missingPdfRecords.length === 0
    && hashMismatches.length === 0
    && invalidPdfRecords.length === 0
    && invalidObjectPdfs.length === 0
    && orphanObjects.length === 0
    && doiRepairPlan.normalize.length === 0
    && doiRepairPlan.clear.length === 0
    && duplicatePdfHashGroups.length === 0
    && duplicateDoiGroups.length === 0
    && recordsWithoutPdf.length === 0;

  return {
    ok,
    fast: Boolean(options.fast),
    library,
    totalPapers: papers.length,
    recordsWithPdf: papers.filter(paper => paper.pdfPath).length,
    recordsWithoutPdf,
    checkedHashes: options.fast ? 0 : verifiedPdfRecords.length + hashMismatches.length,
    missingPdfRecords,
    hashMismatches,
    invalidPdfRecords,
    invalidObjectPdfs,
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
  console.log(`Records without PDF: ${report.recordsWithoutPdf.length}`);
  console.log(`Object PDFs: ${report.objectFiles}`);
  console.log(`Checked hashes: ${report.checkedHashes}${report.fast ? " (fast mode skipped hashing)" : ""}`);
  console.log("");
  console.log(`Missing referenced PDFs: ${report.missingPdfRecords.length}`);
  console.log(`Hash mismatches: ${report.hashMismatches.length}`);
  console.log(`Invalid referenced PDFs: ${report.invalidPdfRecords.length}`);
  console.log(`Invalid orphan PDFs: ${report.invalidObjectPdfs.length}`);
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
  if (report.recordsWithoutPdf.length) {
    console.log("");
    console.log("Records without PDF preview:");
    for (const record of report.recordsWithoutPdf.slice(0, 10)) {
      console.log(`  #${record.id} ${record.doi || "-"} ${record.citekey || "-"}`);
    }
  }
  if (report.hashMismatches.length) {
    console.log("");
    console.log("Hash mismatch preview:");
    for (const item of report.hashMismatches.slice(0, 10)) {
      console.log(`  #${item.record.id} expected ${item.expected.slice(0, 12)}... actual ${item.actual.slice(0, 12)}...`);
    }
  }
  if (report.invalidPdfRecords.length) {
    console.log("");
    console.log("Invalid PDF preview:");
    for (const item of report.invalidPdfRecords.slice(0, 10)) {
      console.log(`  #${item.record.id} ${item.record.doi || "-"} ${item.record.pdfPath || "-"}  ${item.issues.join("; ")}`);
    }
  }
  if (report.invalidObjectPdfs.length) {
    console.log("");
    console.log("Invalid orphan PDF preview:");
    for (const item of report.invalidObjectPdfs.slice(0, 10)) console.log(`  ${item.path}  ${item.issues.join("; ")}`);
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
    authors: paper.authors || [],
    year: paper.year || null,
    pdfSha256: paper.pdfSha256 || null,
    pdfPath: paper.pdfPath || null,
  };
}

async function listManifestBackups(library) {
  await ensureLibrary(library);
  const entries = await fsp.readdir(library, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    const match = /^manifest\.backup-(.+)\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const file = path.join(library, entry.name);
    const stat = await fsp.stat(file);
    backups.push({
      name: entry.name,
      path: file,
      stamp: match[1],
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
  return backups.sort((a, b) => b.name.localeCompare(a.name));
}

function buildBackupPrunePlan(backups, keep) {
  const keepCount = Math.max(0, Number.isFinite(keep) ? Math.floor(keep) : 20);
  return {
    keep: keepCount,
    total: backups.length,
    kept: backups.slice(0, keepCount),
    remove: backups.slice(keepCount),
  };
}

function printBackupList(backups) {
  console.log(`Manifest backups: ${backups.length}`);
  const total = backups.reduce((sum, backup) => sum + backup.bytes, 0);
  console.log(`Total size: ${formatBytes(total)}`);
  for (const backup of backups) {
    console.log(`${backup.name}  ${formatBytes(backup.bytes)}  ${backup.mtime}`);
  }
}

function printBackupPrunePlan(plan, applied = false) {
  console.log(`Manifest backups: ${plan.total}`);
  console.log(`Keep newest: ${plan.keep}`);
  console.log(`${applied ? "Removed" : "Would remove"}: ${plan.remove.length}`);
  const bytes = plan.remove.reduce((sum, backup) => sum + backup.bytes, 0);
  console.log(`${applied ? "Freed" : "Would free"}: ${formatBytes(bytes)}`);
  if (!applied) console.log("Dry run: no files deleted. Use --apply to prune.");
  if (plan.remove.length) {
    console.log("");
    console.log(`${applied ? "Removed" : "Remove preview"}:`);
    for (const backup of plan.remove.slice(0, 20)) {
      console.log(`  ${backup.name}  ${formatBytes(backup.bytes)}`);
    }
    if (plan.remove.length > 20) console.log(`  ... ${plan.remove.length - 20} more backups`);
  }
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

async function buildDoctorReport(library, db) {
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
  const invalidPdfRecords = [];
  for (const paper of papers) {
    if (!paper.pdfPath) continue;
    const absolute = path.join(library, paper.pdfPath);
    if (!fs.existsSync(absolute)) continue;
    const pdfInspection = await inspectPdfFile(absolute);
    if (!pdfInspection.ok) {
      invalidPdfRecords.push({
        record: paperBrief(paper),
        reason: pdfInspection.reason,
        issues: pdfInspection.issues,
        headerPreview: pdfInspection.headerPreview,
      });
    }
  }
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
    invalidPdfRecords,
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
  console.log(`Invalid stored PDFs: ${report.invalidPdfRecords.length}`);
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

  const previewDoiGroups = report.duplicateDoiGroups.slice(0, 10);
  if (previewDoiGroups.length) {
    console.log("");
    console.log("Duplicate DOI preview:");
    for (const group of previewDoiGroups) {
      console.log(`  ${group.doi} (${group.records.length} records)`);
      for (const record of group.records.slice(0, 5)) {
        const hash = record.pdfSha256 ? `${record.pdfSha256.slice(0, 12)}...` : "-";
        console.log(`    #${record.id} ${record.citekey || "-"} ${hash} ${record.title || ""}`.trimEnd());
      }
    }
    if (report.duplicateDoiGroups.length > previewDoiGroups.length) {
      console.log(`  ... ${report.duplicateDoiGroups.length - previewDoiGroups.length} more groups`);
    }
  }

  const previewMissing = report.recordsMissingMetadata.slice(0, 10);
  const previewInvalidPdfs = report.invalidPdfRecords.slice(0, 10);
  if (previewInvalidPdfs.length) {
    console.log("");
    console.log("Invalid PDF preview:");
    for (const item of previewInvalidPdfs) {
      console.log(`  #${item.record.id} ${item.record.doi || "-"} ${item.record.pdfPath || "-"}  ${item.issues.join("; ")}`);
    }
    if (report.invalidPdfRecords.length > previewInvalidPdfs.length) {
      console.log(`  ... ${report.invalidPdfRecords.length - previewInvalidPdfs.length} more records`);
    }
  }

  if (previewMissing.length) {
    console.log("");
    console.log("Missing metadata preview:");
    for (const record of previewMissing) {
      const missing = [];
      if (!record.title) missing.push("title");
      if (!record.year) missing.push("year");
      if (!record.authors?.length) missing.push("authors");
      console.log(`  #${record.id} ${record.doi || "-"} missing: ${missing.join(", ")}`);
    }
    if (report.recordsMissingMetadata.length > previewMissing.length) {
      console.log(`  ... ${report.recordsMissingMetadata.length - previewMissing.length} more records`);
    }
  }
}

async function buildInvalidPdfPrunePlan(library, db) {
  const papers = db.papers || [];
  const invalidRecords = [];
  const referencedPaths = new Set();

  for (const paper of papers) {
    if (!paper.pdfPath) continue;
    referencedPaths.add(path.normalize(paper.pdfPath));
    const absolute = path.join(library, paper.pdfPath);
    if (!fs.existsSync(absolute)) continue;
    const pdfInspection = await inspectPdfFile(absolute);
    if (!pdfInspection.ok) {
      invalidRecords.push({
        record: paperBrief(paper),
        reason: pdfInspection.reason,
        issues: pdfInspection.issues,
        headerPreview: pdfInspection.headerPreview,
      });
    }
  }

  const objectsRoot = path.join(library, "objects");
  const objectFiles = await collectFiles(objectsRoot, file => file.toLowerCase().endsWith(".pdf"));
  const invalidOrphanObjects = [];
  for (const file of objectFiles) {
    const rel = path.relative(library, file);
    if (referencedPaths.has(path.normalize(rel))) continue;
    const pdfInspection = await inspectPdfFile(file);
    if (!pdfInspection.ok) {
      invalidOrphanObjects.push({
        path: rel,
        reason: pdfInspection.reason,
        issues: pdfInspection.issues,
        headerPreview: pdfInspection.headerPreview,
      });
    }
  }

  const removeIds = new Set(invalidRecords.map(item => item.record.id));
  const remainingPdfPaths = new Set(papers
    .filter(paper => !removeIds.has(paper.id))
    .map(paper => paper.pdfPath)
    .filter(Boolean)
    .map(pdfPath => path.normalize(pdfPath)));
  const deletePdfPaths = uniqueValues([
    ...invalidRecords
      .map(item => item.record.pdfPath)
      .filter(Boolean)
      .filter(pdfPath => !remainingPdfPaths.has(path.normalize(pdfPath))),
    ...invalidOrphanObjects.map(item => item.path),
  ]).sort();

  return {
    library,
    invalidRecords,
    invalidOrphanObjects,
    removeRecordIds: Array.from(removeIds).sort((a, b) => a - b),
    deletePdfPaths,
  };
}

async function applyInvalidPdfPrune(library, db, plan) {
  const removeIds = new Set(plan.removeRecordIds);
  const before = (db.papers || []).length;
  db.papers = (db.papers || []).filter(paper => !removeIds.has(paper.id));
  const removedRecords = before - db.papers.length;
  const backup = removedRecords ? await backupManifest(library) : null;
  if (removedRecords) await writeDb(library, db);

  const deletedPdfPaths = [];
  for (const pdfPath of plan.deletePdfPaths) {
    const absolute = path.join(library, pdfPath);
    if (!fs.existsSync(absolute)) continue;
    await fsp.unlink(absolute);
    deletedPdfPaths.push(pdfPath);
  }

  return { backup, removedRecords, deletedPdfPaths };
}

function printInvalidPdfPrunePlan(plan, applied = null) {
  console.log(`Invalid PDF records: ${plan.invalidRecords.length}`);
  console.log(`Invalid orphan PDFs: ${plan.invalidOrphanObjects.length}`);
  console.log(`Records that would be removed: ${plan.removeRecordIds.length}`);
  console.log(`PDF objects that would be deleted: ${plan.deletePdfPaths.length}`);
  if (applied) {
    console.log(`Applied: removed ${applied.removedRecords} records; deleted PDFs ${applied.deletedPdfPaths.length}`);
    if (applied.backup) console.log(`Backup: ${applied.backup}`);
  } else {
    console.log("Dry run: no changes written. Use --apply to remove invalid PDF records and delete unreferenced invalid PDF objects.");
  }

  if (plan.invalidRecords.length) {
    console.log("");
    console.log("Invalid record preview:");
    for (const item of plan.invalidRecords.slice(0, 10)) {
      console.log(`  #${item.record.id} ${item.record.doi || "-"} ${item.record.pdfPath || "-"}  ${item.issues.join("; ")}`);
    }
    if (plan.invalidRecords.length > 10) console.log(`  ... ${plan.invalidRecords.length - 10} more records`);
  }

  if (plan.invalidOrphanObjects.length) {
    console.log("");
    console.log("Invalid orphan preview:");
    for (const item of plan.invalidOrphanObjects.slice(0, 10)) console.log(`  ${item.path}  ${item.issues.join("; ")}`);
    if (plan.invalidOrphanObjects.length > 10) console.log(`  ... ${plan.invalidOrphanObjects.length - 10} more PDFs`);
  }

  if (plan.deletePdfPaths.length) {
    console.log("");
    console.log("Delete PDF preview:");
    for (const pdfPath of plan.deletePdfPaths.slice(0, 10)) console.log(`  ${pdfPath}`);
    if (plan.deletePdfPaths.length > 10) console.log(`  ... ${plan.deletePdfPaths.length - 10} more PDFs`);
  }
}

function metadataIssues(paper) {
  const missing = [];
  if (!paper.title) missing.push("title");
  if (!paper.year) missing.push("year");
  if (!paper.authors?.length) missing.push("authors");
  return missing;
}

async function planRepairMetadata(db, options = {}) {
  const candidates = (db.papers || []).filter(paper => paper.doi && metadataIssues(paper).length);
  const crossref = createCrossrefClient(options.crossref);
  const updates = [];
  const unchanged = [];
  const failed = [];
  for (const paper of candidates) {
    try {
      const metadata = await metadataForDoi(paper.doi, "", options.noCrossref, crossref);
      const fields = {};
      if (!paper.title && metadata.title) fields.title = metadata.title;
      if (!paper.year && metadata.year) fields.year = metadata.year;
      if (!paper.authors?.length && metadata.authors?.length) fields.authors = metadata.authors;
      if (Object.keys(fields).length) {
        updates.push({
          record: paperBrief(paper),
          missing: metadataIssues(paper),
          fields,
        });
      } else {
        unchanged.push({
          record: paperBrief(paper),
          missing: metadataIssues(paper),
        });
      }
    } catch (error) {
      failed.push({
        record: paperBrief(paper),
        missing: metadataIssues(paper),
        error: error.message,
      });
    }
  }
  return { candidates: candidates.length, updates, unchanged, failed };
}

async function applyRepairMetadata(library, db, plan) {
  const byId = new Map((db.papers || []).map(paper => [paper.id, paper]));
  let updatedRecords = 0;
  for (const item of plan.updates) {
    const paper = byId.get(item.record.id);
    if (!paper) continue;
    for (const [field, value] of Object.entries(item.fields)) paper[field] = value;
    paper.updatedAt = nowIso();
    updatedRecords++;
  }
  let backup = null;
  if (updatedRecords) {
    backup = await backupManifest(library);
    await writeDb(library, db);
  }
  return { backup, updatedRecords };
}

function printRepairMetadataPlan(plan, applied = null) {
  console.log(`Records missing title/year/authors with DOI: ${plan.candidates}`);
  console.log(`Records with Crossref updates: ${plan.updates.length}`);
  console.log(`Records still missing after lookup: ${plan.unchanged.length}`);
  console.log(`Lookup failures: ${plan.failed.length}`);
  if (applied) {
    console.log(`Applied: updated ${applied.updatedRecords} records`);
    if (applied.backup) console.log(`Backup: ${applied.backup}`);
  } else {
    console.log("Dry run: no changes written. Use --apply to fill missing metadata fields.");
  }

  if (plan.updates.length) {
    console.log("");
    console.log("Update preview:");
    for (const item of plan.updates.slice(0, 10)) {
      console.log(`  #${item.record.id} ${item.record.doi} fill: ${Object.keys(item.fields).join(", ")}`);
    }
    if (plan.updates.length > 10) console.log(`  ... ${plan.updates.length - 10} more records`);
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

function extraPdfPathsForMergePlans(db, mergePlans) {
  const removeIds = new Set(mergePlans.flatMap(plan => plan.remove.map(record => record.id)));
  const remainingPdfPaths = new Set((db.papers || [])
    .filter(paper => !removeIds.has(paper.id))
    .map(paper => paper.pdfPath)
    .filter(Boolean));
  return uniqueValues(mergePlans
    .flatMap(plan => plan.remove.map(record => record.pdfPath).filter(Boolean))
    .filter(pdfPath => !remainingPdfPaths.has(pdfPath)))
    .sort();
}

function planDedupeDoi(db, options = {}) {
  const byId = new Map((db.papers || []).map(paper => [paper.id, paper]));
  const keepId = options.keepId || null;
  const removeIds = options.removeIds || [];
  const mergePlans = [];
  const conflictGroups = [];

  if (keepId || removeIds.length) {
    if (!keepId || !removeIds.length) throw new Error("Use --keep ID together with at least one --remove ID.");
    const canonical = byId.get(keepId);
    if (!canonical) throw new Error(`No record matched --keep ${keepId}.`);
    const duplicates = removeIds.map(id => {
      if (id === keepId) throw new Error("--keep ID cannot also be removed.");
      const paper = byId.get(id);
      if (!paper) throw new Error(`No record matched --remove ${id}.`);
      return paper;
    });
    const doi = canonical.doi ? normalizeDoi(canonical.doi) : null;
    if (!doi) throw new Error("--keep record has no DOI.");
    for (const duplicate of duplicates) {
      if (!duplicate.doi || normalizeDoi(duplicate.doi) !== doi) {
        throw new Error(`--remove ${duplicate.id} does not share DOI ${doi}.`);
      }
    }
    mergePlans.push({
      doi,
      canonical: paperBrief(canonical),
      remove: duplicates.map(paperBrief),
      mergedRecordIds: duplicates.map(record => record.id),
      manual: true,
    });
    const deletePdfPaths = extraPdfPathsForMergePlans(db, mergePlans);
    return {
      safeGroups: 1,
      conflictGroups: 0,
      mergePlans,
      conflictPreview: [],
      deletePdfPaths,
      manual: true,
    };
  }

  const groups = duplicateGroupsBy(db.papers || [], paper => paper.doi ? normalizeDoi(paper.doi) : null);
  for (const group of groups) {
    const records = group.items.slice().sort((a, b) => a.id - b.id);
    const pdfHashes = uniqueValues(records.map(record => record.pdfSha256).filter(Boolean));
    if (pdfHashes.length > 1) {
      conflictGroups.push({
        doi: group.key,
        pdfSha256Values: pdfHashes,
        records: records.map(paperBrief),
      });
      continue;
    }
    const canonical = chooseCanonical(records);
    const duplicateRecords = records.filter(record => record.id !== canonical.id);
    mergePlans.push({
      doi: group.key,
      canonical: paperBrief(canonical),
      remove: duplicateRecords.map(paperBrief),
      mergedRecordIds: duplicateRecords.map(record => record.id),
      manual: false,
    });
  }

  return {
    safeGroups: mergePlans.length,
    conflictGroups: conflictGroups.length,
    mergePlans,
    conflictPreview: conflictGroups.slice(0, 10),
    deletePdfPaths: extraPdfPathsForMergePlans(db, mergePlans),
    manual: false,
  };
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

async function applyDedupeDoi(library, db, plan, options = {}) {
  if (plan.deletePdfPaths.length && !options.deleteExtraPdfs) {
    throw new Error("This DOI merge would leave extra PDF objects. Re-run with --delete-extra-pdfs after checking the preview.");
  }
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
  const deletedPdfPaths = [];
  if (options.deleteExtraPdfs) {
    for (const pdfPath of plan.deletePdfPaths) {
      const absolute = path.join(library, pdfPath);
      if (fs.existsSync(absolute)) {
        await fsp.unlink(absolute);
        deletedPdfPaths.push(pdfPath);
      }
    }
  }
  return { backup, removedRecords: removeIds.size, deletedPdfPaths };
}

function printDedupeDoiPlan(plan, applied = null) {
  console.log(`Safe duplicate DOI groups: ${plan.safeGroups}`);
  console.log(`Conflict duplicate DOI groups: ${plan.conflictGroups}`);
  console.log(`Records that would be removed: ${plan.mergePlans.reduce((sum, item) => sum + item.remove.length, 0)}`);
  console.log(`Extra PDF objects that would be deleted with --delete-extra-pdfs: ${plan.deletePdfPaths.length}`);
  if (applied) {
    console.log(`Applied: removed ${applied.removedRecords} records; deleted PDFs ${applied.deletedPdfPaths.length}`);
    console.log(`Backup: ${applied.backup}`);
  } else {
    console.log("Dry run: no changes written. Use --apply to merge safe groups.");
  }

  if (plan.mergePlans.length) {
    console.log("");
    console.log("DOI merge preview:");
    for (const item of plan.mergePlans.slice(0, 10)) {
      console.log(`  DOI ${item.doi}`);
      console.log(`    keep #${item.canonical.id} ${item.canonical.citekey || "-"} ${item.canonical.pdfSha256 ? item.canonical.pdfSha256.slice(0, 12) + "..." : "-"}`);
      console.log(`    remove: ${item.remove.map(record => `#${record.id}`).join(", ")}`);
    }
    if (plan.mergePlans.length > 10) console.log(`  ... ${plan.mergePlans.length - 10} more groups`);
  }

  if (plan.deletePdfPaths.length) {
    console.log("");
    console.log("Extra PDF delete preview:");
    for (const pdfPath of plan.deletePdfPaths.slice(0, 10)) console.log(`  ${pdfPath}`);
    if (plan.deletePdfPaths.length > 10) console.log(`  ... ${plan.deletePdfPaths.length - 10} more PDFs`);
  }

  if (plan.conflictPreview.length) {
    console.log("");
    console.log("Conflict preview, not auto-merged:");
    for (const group of plan.conflictPreview) {
      console.log(`  DOI ${group.doi} has ${group.pdfSha256Values.length} different PDF hashes`);
      for (const record of group.records.slice(0, 5)) {
        console.log(`    #${record.id} ${record.citekey || "-"} ${record.pdfSha256 ? record.pdfSha256.slice(0, 12) + "..." : "-"}`);
      }
    }
  }
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

function readNonNegativeNumberOption(args, name, fallback) {
  const raw = readOption(args, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function readCrossrefOptions(args) {
  const delayMs = readNonNegativeNumberOption(args, "--crossref-delay", DEFAULT_CROSSREF_DELAY_MS);
  const retries = readNonNegativeNumberOption(args, "--crossref-retries", DEFAULT_CROSSREF_RETRIES);
  if (!Number.isInteger(retries)) throw new Error("--crossref-retries must be a non-negative integer.");
  return { delayMs, retries };
}

function parseVersionTag(value) {
  const raw = String(value || "").trim();
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(raw);
  if (!match) return null;
  return { version: match[1], tag: raw.startsWith("v") ? raw : `v${match[1]}` };
}

function compareVersions(left, right) {
  const leftParts = String(left).replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).replace(/^v/, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchGithubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `litvault/${VERSION}`,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchLatestGithubVersion() {
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  try {
    const release = await fetchGithubJson(releaseUrl);
    const parsed = parseVersionTag(release.tag_name || release.name);
    if (parsed) return { ...parsed, source: "latest release" };
  } catch (error) {
    // Fall through to tags so repos without GitHub Releases can still self-update.
  }

  const tags = await fetchGithubJson(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=100`);
  const candidates = tags
    .map(tag => parseVersionTag(tag.name))
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length) throw new Error(`No version tags found in ${GITHUB_REPO}.`);
  return { ...candidates[0], source: "tags" };
}

async function updateLitvault(args) {
  const check = readFlag(args, "--check");
  const dryRun = readFlag(args, "--dry-run");
  const force = readFlag(args, "--force");
  const ref = readOption(args, "--ref");
  if (args.length) throw new Error(`Unknown update option: ${args[0]}`);

  let target;
  if (ref) {
    const parsed = parseVersionTag(ref);
    target = parsed
      ? { ...parsed, source: "--ref" }
      : { version: ref.replace(/^v/, ""), tag: ref, source: "--ref" };
  } else {
    target = await fetchLatestGithubVersion();
  }

  const packageSpec = `github:${GITHUB_REPO}#${target.tag}`;
  console.log(`Current version: ${VERSION}`);
  console.log(`Latest version: ${target.version} (${target.source})`);

  if (!force && compareVersions(target.version, VERSION) <= 0) {
    console.log("Already up to date.");
    return 0;
  }

  if (check || dryRun) {
    console.log(`Would run: npm install -g ${packageSpec}`);
    return 0;
  }

  const result = spawnSync("npm", ["install", "-g", packageSpec], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status || 1;
  console.log(`Updated litvault to ${target.tag}. Run: litvault --version`);
  return 0;
}

async function queriesFromArgsAndFile(args) {
  const file = readOption(args, "--file");
  const values = [...args];
  if (file) values.push(...await readListFile(file));
  return uniqueValues(values);
}

function doiValuesFromQueries(queries) {
  return uniqueValues(queries.flatMap(value => {
    const found = findDoisInText(value);
    return found.length ? found : [normalizeDoi(value)];
  }));
}

function buildMissingDoiReport(db, queries) {
  const requested = doiValuesFromQueries(queries);
  const stored = new Set((db.papers || []).map(paper => paper.doi ? normalizeDoi(paper.doi) : null).filter(Boolean));
  const valid = requested.filter(doi => isValidDoi(doi));
  const invalid = requested.filter(doi => !isValidDoi(doi));
  const missing = valid.filter(doi => !stored.has(doi));
  const present = valid.filter(doi => stored.has(doi));
  return {
    requested,
    present,
    missing,
    invalid,
  };
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

  if (command === "update") {
    return updateLitvault(args);
  }

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
    const crossref = readCrossrefOptions(args);
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
      crossref,
      verbose,
      progress: !quiet && !verbose && process.stderr.isTTY,
    });
    console.log(
      `Imported PDFs: ${result.imported}; updated existing records: ${result.updated}; ` +
      `skipped existing PDFs: ${result.skippedExistingPdf}; skipped duplicate input PDFs: ${result.skippedDuplicateInput}; ` +
      `skipped invalid PDFs: ${result.skippedInvalidPdf}; skipped DOI conflicts: ${result.skippedDoiConflict}; skipped without DOI: ${result.skippedNoDoi}; ` +
      `DOI sources: explicit ${result.explicitDoi}, metadata ${result.metadataDoi}, content ${result.contentDoi}, filename ${result.filenameDoiFallback}; ` +
      `Library: ${result.library}`
    );
    return result.skippedInvalidPdf || result.skippedNoDoi || result.skippedDoiConflict ? 1 : 0;
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

  if (command === "missing-dois") {
    const json = readFlag(args, "--json");
    const queries = await queriesFromArgsAndFile(args);
    if (!queries.length) throw new Error("Missing DOI values. Pass DOI... or --file dois.txt.");
    const db = await readDb(library);
    const report = buildMissingDoiReport(db, queries);
    if (json) {
      console.log(JSON.stringify({ ...report, library }, null, 2));
    } else {
      for (const doi of report.missing) console.log(doi);
      for (const doi of report.invalid) console.error(`Invalid DOI: ${doi}`);
    }
    return 0;
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

  if (command === "backup") {
    const action = args.shift() || "list";
    if (action === "list") {
      const json = readFlag(args, "--json");
      const backups = await listManifestBackups(library);
      if (json) {
        console.log(JSON.stringify({
          library,
          count: backups.length,
          totalBytes: backups.reduce((sum, backup) => sum + backup.bytes, 0),
          backups,
        }, null, 2));
      } else {
        printBackupList(backups);
      }
      return 0;
    }
    if (action === "prune") {
      const json = readFlag(args, "--json");
      const apply = readFlag(args, "--apply");
      const keep = Number(readOption(args, "--keep", "20"));
      if (!Number.isFinite(keep) || keep < 0) throw new Error("--keep must be a non-negative number.");
      const backups = await listManifestBackups(library);
      const plan = buildBackupPrunePlan(backups, keep);
      if (apply) {
        for (const backup of plan.remove) await fsp.unlink(backup.path);
      }
      if (json) {
        console.log(JSON.stringify({
          library,
          applied: apply,
          plan,
        }, null, 2));
      } else {
        printBackupPrunePlan(plan, apply);
      }
      return 0;
    }
    throw new Error(`Unknown backup action: ${action}`);
  }

  if (command === "doctor") {
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const report = await buildDoctorReport(library, db);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printDoctorReport(report);
    }
    return 0;
  }

  if (command === "prune-invalid-pdfs") {
    const apply = readFlag(args, "--apply");
    const json = readFlag(args, "--json");
    const db = await readDb(library);
    const plan = await buildInvalidPdfPrunePlan(library, db);
    let applied = null;
    if (apply) applied = await applyInvalidPdfPrune(library, db, plan);
    if (json) {
      console.log(JSON.stringify({ plan, applied, library }, null, 2));
    } else {
      printInvalidPdfPrunePlan(plan, applied);
    }
    return 0;
  }

  if (command === "repair-metadata") {
    const apply = readFlag(args, "--apply");
    const json = readFlag(args, "--json");
    const noCrossref = readFlag(args, "--no-crossref");
    const crossref = readCrossrefOptions(args);
    const db = await readDb(library);
    const plan = await planRepairMetadata(db, { noCrossref, crossref });
    let applied = null;
    if (apply) applied = await applyRepairMetadata(library, db, plan);
    if (json) {
      console.log(JSON.stringify({ plan, applied, library }, null, 2));
    } else {
      printRepairMetadataPlan(plan, applied);
    }
    return plan.failed.length ? 1 : 0;
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

  if (command === "dedupe-doi") {
    const apply = readFlag(args, "--apply");
    const json = readFlag(args, "--json");
    const deleteExtraPdfs = readFlag(args, "--delete-extra-pdfs");
    const keepArg = readOption(args, "--keep");
    const removeArgs = readRepeated(args, "--remove");
    if (args.length) throw new Error(`Unknown dedupe-doi option: ${args[0]}`);
    const keepId = keepArg ? Number(keepArg) : null;
    const removeIds = removeArgs.map(value => Number(value));
    if ((keepArg && !Number.isInteger(keepId)) || removeIds.some(value => !Number.isInteger(value))) {
      throw new Error("--keep and --remove values must be record IDs.");
    }
    const db = await readDb(library);
    const plan = planDedupeDoi(db, { keepId, removeIds });
    let applied = null;
    if (apply) applied = await applyDedupeDoi(library, db, plan, { deleteExtraPdfs });
    if (json) {
      console.log(JSON.stringify({ plan, applied, library }, null, 2));
    } else {
      printDedupeDoiPlan(plan, applied);
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

  throw new Error(`Unknown command: ${command}`);
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`litvault: ${error.message}`);
    process.exit(1);
  });
