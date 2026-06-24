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
    const cwdOut = path.join(temp, "cwd-out");
    const batch = path.join(temp, "batch");
    const pdf = path.join(temp, "paper.pdf");
    const metadataPdf = path.join(temp, "metadata.pdf");
    const filenameDoiPdf = path.join(temp, "10.2468_filename-only.pdf");
    const conflictPdf = path.join(temp, "10.1111_filename-conflict.pdf");
    const pdf2 = path.join(batch, "nested", "second.pdf");
    const doiFile = path.join(temp, "dois.txt");
    const selectedBib = path.join(temp, "selected.bib");
    await fsp.writeFile(pdf, "%PDF-1.4\nDOI 10.1234/example\n", "utf8");
    await fsp.writeFile(metadataPdf, "%PDF-1.4\n<x:xmpmeta><prism:doi>10.1357/metadata-only</prism:doi></x:xmpmeta>\n", "utf8");
    await fsp.writeFile(filenameDoiPdf, "%PDF-1.4\nNo extractable DOI in this PDF body.\n", "utf8");
    await fsp.writeFile(conflictPdf, "%PDF-1.4\n<x:xmpmeta><prism:doi>10.2222/metadata-conflict</prism:doi></x:xmpmeta>\n", "utf8");
    await fsp.mkdir(path.dirname(pdf2), { recursive: true });
    await fsp.writeFile(pdf2, "%PDF-1.4\nDOI 10.5678/second\n", "utf8");
    await fsp.writeFile(doiFile, "10.1234/example\n10.9999/metadata-only)\n", "utf8");

    run(["config", "set", "library", library], { configRoot: temp });
    const config = run(["config", "get"], { configRoot: temp });
    if (!config.includes(library)) throw new Error("configured library missing from config get");

    run(["init"], { configRoot: temp });
    if (fs.existsSync(path.join(library, "exports")) || fs.existsSync(path.join(library, "notes"))) {
      throw new Error("init should not create unused exports or notes directories");
    }
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
    const metadataDoiAdd = run(["add", metadataPdf, "--no-crossref"], { configRoot: temp });
    if (!metadataDoiAdd.includes("metadata 1")) {
      throw new Error("metadata DOI source was not reported");
    }
    const metadataDoiInfo = JSON.parse(run(["--library", library, "info", "10.1357/metadata-only"]));
    if (metadataDoiInfo.doiSource !== "pdf-metadata") {
      throw new Error("metadata DOI source was not stored");
    }
    const filenameDoiAdd = run(["add", filenameDoiPdf, "--no-crossref"], { configRoot: temp });
    if (!filenameDoiAdd.includes("filename 1")) {
      throw new Error("filename DOI fallback was not reported");
    }
    const filenameDoiInfo = JSON.parse(run(["--library", library, "info", "10.2468/filename-only"]));
    if (filenameDoiInfo.doi !== "10.2468/filename-only" || filenameDoiInfo.doiSource !== "filename") {
      throw new Error("filename DOI fallback did not create the expected DOI");
    }
    const scanJson = JSON.parse(run(["scan-doi", metadataPdf, filenameDoiPdf, "--json"], { configRoot: temp }));
    if (scanJson[0].source !== "pdf-metadata" || scanJson[1].source !== "filename") {
      throw new Error("scan-doi JSON did not report expected DOI sources");
    }
    const conflictScan = spawnSync(process.execPath, [cli, "scan-doi", conflictPdf], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: path.join(temp, "xdg") },
    });
    if (conflictScan.status !== 2 || !conflictScan.stdout.includes("Status: conflict")) {
      throw new Error("scan-doi did not report DOI conflicts");
    }
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

    await fsp.writeFile(path.join(library, "manifest.backup-2000-01-01T00-00-00-000Z.json"), "{}\n", "utf8");
    await fsp.writeFile(path.join(library, "manifest.backup-2000-01-02T00-00-00-000Z.json"), "{}\n", "utf8");
    await fsp.writeFile(path.join(library, "manifest.backup-2000-01-03T00-00-00-000Z.json"), "{}\n", "utf8");
    const backupList = run(["--library", library, "backup", "list"]);
    if (!backupList.includes("Manifest backups:") || !backupList.includes("manifest.backup-2000-01-03T00-00-00-000Z.json")) {
      throw new Error("backup list did not show expected manifest backups");
    }
    const backupPruneDryRun = run(["--library", library, "backup", "prune", "--keep", "2"]);
    if (!backupPruneDryRun.includes("Dry run") || !backupPruneDryRun.includes("Would remove:")) {
      throw new Error("backup prune dry-run did not report planned removal");
    }
    const backupPruneApply = run(["--library", library, "backup", "prune", "--keep", "2", "--apply"]);
    if (!backupPruneApply.includes("Removed:")) {
      throw new Error("backup prune apply did not report removal");
    }
    const backupListJson = JSON.parse(run(["--library", library, "backup", "list", "--json"]));
    if (backupListJson.count !== 2) {
      throw new Error("backup prune did not keep expected number of backups");
    }

    const verify = run(["--library", library, "verify"]);
    if (!verify.includes("Integrity: OK") || !verify.includes("Hash mismatches: 0")) {
      throw new Error("verify did not report clean integrity");
    }
    const verifyJson = JSON.parse(run(["--library", library, "verify", "--json"]));
    if (!verifyJson.ok || verifyJson.hashMismatches.length !== 0) {
      throw new Error("verify JSON did not report clean integrity");
    }

    const search = run(["--library", library, "search", "smoke"]);
    if (!search.includes("10.1234/example")) throw new Error("search output missing DOI");

    const stats = run(["--library", library, "stats"]);
    if (!stats.includes("Papers: 5") || !stats.includes("With PDF: 4") || !stats.includes("DOI sources:")) {
      throw new Error("stats output missing expected counts");
    }
    const statsJson = JSON.parse(run(["--library", library, "stats", "--json"]));
    if (statsJson.totalPapers !== 5 || statsJson.withPdf !== 4 || !statsJson.doiSources.some(item => item.name === "pdf-metadata")) {
      throw new Error("stats JSON missing expected counts");
    }

    await fsp.mkdir(cwdOut, { recursive: true });
    const copiedToCwd = run([
      "--library",
      library,
      "get",
      "10.1234/example",
      "--name",
      "{citekey}.pdf",
    ], { cwd: cwdOut }).trim().split(/\r?\n/)[0];
    if (!fs.existsSync(copiedToCwd) || fs.realpathSync(path.dirname(copiedToCwd)) !== fs.realpathSync(cwdOut)) {
      throw new Error("get without --to did not copy into the current working directory");
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
