#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "bin", "litvault-node.js");

function run(args, options = {}) {
  const { configRoot, ...spawnOptions } = options;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(configRoot || os.tmpdir(), "xdg") },
    ...spawnOptions,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: litvault ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result.stdout;
}

async function main() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "litvault-smoke-"));
  try {
    const library = path.join(temp, "library");
    const out = path.join(temp, "out");
    const batch = path.join(temp, "batch");
    const pdf = path.join(temp, "paper.pdf");
    const pdf2 = path.join(batch, "nested", "second.pdf");
    const doiFile = path.join(temp, "dois.txt");
    const selectedBib = path.join(temp, "selected.bib");
    await fsp.writeFile(pdf, "%PDF-1.4\nDOI 10.1234/example\n", "utf8");
    await fsp.mkdir(path.dirname(pdf2), { recursive: true });
    await fsp.writeFile(pdf2, "%PDF-1.4\nDOI 10.5678/second\n", "utf8");
    await fsp.writeFile(doiFile, "10.1234/example\n10.9999/metadata-only)\n", "utf8");

    run(["config", "set", "library", library], { configRoot: temp });
    const config = run(["config", "get"], { configRoot: temp });
    if (!config.includes(library)) throw new Error("configured library missing from config get");

    run(["init"], { configRoot: temp });
    run([
      "add",
      pdf,
      "--doi",
      "10.1234/example",
      "--title",
      "Smoke Test Paper",
      "--no-crossref",
      "--tag",
      "smoke",
    ], { configRoot: temp });
    run(["add", batch, "--no-crossref", "--tag", "batch"], { configRoot: temp });
    const duplicateAdd = run(["add", batch, "--no-crossref", "--tag", "batch"], { configRoot: temp });
    if (!duplicateAdd.includes("skipped existing PDFs: 1")) {
      throw new Error("duplicate directory import did not skip existing PDFs");
    }
    const verboseDuplicateAdd = run(["add", batch, "--no-crossref", "--tag", "batch", "--verbose"], { configRoot: temp });
    if (!verboseDuplicateAdd.includes("Skipping already stored PDF:")) {
      throw new Error("verbose duplicate import did not print per-file details");
    }
    run(["--library", library, "import-dois", "--file", doiFile, "--no-crossref", "--tag", "doi-list"]);
    const normalizedInfo = run(["--library", library, "info", "10.9999/metadata-only"]);
    if (!normalizedInfo.includes('"doi": "10.9999/metadata-only"')) {
      throw new Error("DOI trailing punctuation was not normalized");
    }

    const manifest = path.join(library, "manifest.json");
    const db = JSON.parse(await fsp.readFile(manifest, "utf8"));
    const duplicateSource = db.papers.find(paper => paper.doi === "10.5678/second");
    db.papers.push({
      ...duplicateSource,
      id: db.nextId++,
      doi: `${duplicateSource.doi})`,
      citekey: `${duplicateSource.citekey}dup`,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await fsp.writeFile(manifest, JSON.stringify(db, null, 2) + "\n", "utf8");

    const doctor = run(["--library", library, "doctor"]);
    if (!doctor.includes("Duplicate PDF hash groups: 1")) {
      throw new Error("doctor did not report duplicate PDF hash group");
    }
    const dedupeDryRun = run(["--library", library, "dedupe"]);
    if (!dedupeDryRun.includes("Records that would be removed: 1")) {
      throw new Error("dedupe dry-run did not plan one removal");
    }
    const dedupeApply = run(["--library", library, "dedupe", "--apply"]);
    if (!dedupeApply.includes("Applied: removed 1 records")) {
      throw new Error("dedupe apply did not remove one record");
    }

    const repairDb = JSON.parse(await fsp.readFile(manifest, "utf8"));
    repairDb.papers.find(paper => paper.doi === "10.9999/metadata-only").doi = "not-a-doi";
    repairDb.papers.find(paper => paper.doi === "10.5678/second").doi = "https://doi.org/10.5678/second)";
    await fsp.writeFile(manifest, JSON.stringify(repairDb, null, 2) + "\n", "utf8");
    const repairPreview = run(["--library", library, "repair-doi"]);
    if (!repairPreview.includes("Normalizable DOI values: 1") || !repairPreview.includes("Invalid DOI values to clear: 1")) {
      throw new Error("repair-doi dry-run did not report expected DOI fixes");
    }
    const repairApply = run(["--library", library, "repair-doi", "--apply"]);
    if (!repairApply.includes("Applied: normalized 1; cleared 1")) {
      throw new Error("repair-doi apply did not apply expected DOI fixes");
    }

    const search = run(["--library", library, "search", "smoke"]);
    if (!search.includes("10.1234/example")) throw new Error("search output missing DOI");

    const stats = run(["--library", library, "stats"]);
    if (!stats.includes("Papers: 3") || !stats.includes("With PDF: 2")) {
      throw new Error("stats output missing expected counts");
    }
    const statsJson = JSON.parse(run(["--library", library, "stats", "--json"]));
    if (statsJson.totalPapers !== 3 || statsJson.withPdf !== 2) {
      throw new Error("stats JSON missing expected counts");
    }

    const copied = run([
      "--library",
      library,
      "get",
      "10.1234/example",
      "--to",
      out,
      "--name",
      "{citekey}.pdf",
    ]).trim().split(/\r?\n/)[0];
    if (!fs.existsSync(copied)) throw new Error("copied PDF does not exist");

    const copiedBatch = run([
      "--library",
      library,
      "get",
      "10.1234/example",
      "10.5678/second",
      "--to",
      out,
      "--name",
      "{doi}.pdf",
    ]);
    if (!copiedBatch.includes("Copied PDFs: 2; failed: 0")) {
      throw new Error("batch get did not copy both PDFs");
    }

    const bib = run(["--library", library, "export-bib"]);
    if (!bib.includes("@misc") || !bib.includes("10.1234/example")) {
      throw new Error("BibTeX export missing expected fields");
    }
    run(["--library", library, "export-bib", "10.1234/example", "--out", selectedBib]);
    const selected = await fsp.readFile(selectedBib, "utf8");
    if (!selected.includes("10.1234/example") || selected.includes("10.5678/second")) {
      throw new Error("selected BibTeX export has wrong contents");
    }
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
