# litvault

[中文](README.md) | English

`litvault` is a DOI-centered local literature vault CLI.

It is implemented in Node.js, installs with npm, stores metadata in a local `manifest.json`, and stores PDFs by SHA256 content hash.

## Install

Install the latest GitHub release:

```bash
npm install -g github:iihciyekub/litvault#semver:*
litvault --help
lv --help
```

This resolves the newest semantic version tag, so the command does not need to change when a newer release is published.

`lv` is a short alias for `litvault`.

Update to the latest GitHub release:

```bash
litvault update
```

Check or preview the update:

```bash
litvault update --check
litvault update --dry-run
```

From this project directory during local development:

```bash
cd /Users/iipro/iiresearch/litvault
npm install -g .
litvault --help
lv --help
```

For development:

```bash
npm link
litvault --version
```

Without installing globally:

```bash
cd /Users/iipro/iiresearch/litvault
bin/litvault --help
```

`litvault` does not require Python or SQLite.

If the package is later published to npm:

```bash
npm install -g litvault
litvault --help
```

## Storage

By default, the library lives at:

```text
/Volumes/REFSSD/litvault-library/
  manifest.json
  objects/
    sha256/
```

Use another library directory once:

```bash
litvault --library /path/to/library init
```

Set a persistent default library, for example on an external SSD:

```bash
litvault config set library /Volumes/REFSSD/litvault-library
litvault init
litvault config get
```

After that, normal commands use the configured SSD library:

```bash
litvault add ~/Downloads/papers
litvault list
```

Override it temporarily:

```bash
litvault --library /path/to/other-library list
```

You can also use an environment variable:

```bash
LITVAULT_LIBRARY=/Volumes/REFSSD/litvault-library litvault add ~/Downloads/papers
```

The DOI is the main identity key. If you import the same DOI again, `litvault` updates the existing record instead of creating a duplicate.

The PDF object store is content-addressed. If the exact same PDF bytes are imported again, the stored PDF object is reused.

Directory imports use in-memory indexes for fast deduplication. On `litvault add DIR`, the CLI loads the manifest once, builds DOI and PDF-hash maps, skips PDFs already stored by SHA256, skips duplicate files within the same input batch, and writes the manifest once at the end.

## Quick Start

```bash
litvault init
litvault config set library /Volumes/REFSSD/litvault-library
litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
litvault add ~/Downloads/papers
litvault scan-doi ~/Downloads/papers
litvault missing-dois --file dois.txt
litvault search transformer
litvault stats
litvault info 10.1038/s41586-020-2649-2
litvault get --file dois.txt --to ~/Desktop/refs
litvault export-bib --out ~/Desktop/references.bib
litvault verify
```

## Commands

```bash
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
```

## Add PDFs

Add one PDF with an explicit DOI:

```bash
litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
```

Add one PDF and let `litvault` scan for a DOI:

```bash
litvault add ~/Downloads/paper.pdf
```

Add a directory recursively:

```bash
litvault add ~/Downloads/papers
```

Add only PDFs directly inside a directory:

```bash
litvault add ~/Downloads/papers --no-recursive
```

Add tags:

```bash
litvault add ~/Downloads/papers --tag ai --tag methods
```

Skip Crossref metadata lookup:

```bash
litvault add ~/Downloads/papers --no-crossref
```

When importing a directory, `litvault` only processes `.pdf` files. A PDF is imported only if a DOI is found in PDF metadata/content or can be recovered from a DOI-shaped filename. Files without a DOI are skipped and reported.

During directory import, existing PDFs are skipped before DOI extraction and metadata lookup. If a PDF is new but its DOI already exists in the vault, the existing record is updated with the new PDF instead of creating another record.

If PDF metadata/content and the filename produce conflicting DOI values, `litvault` skips that PDF and reports a DOI conflict instead of guessing.

Default directory imports show a compact progress line and a final summary. Use `--verbose` to print every stored/skipped file, or `--quiet` to print only the final summary:

```bash
litvault add ~/Downloads/papers --verbose
litvault add ~/Downloads/papers --quiet
```

## DOI Scanning

Inspect DOI extraction without importing:

```bash
litvault scan-doi ~/Downloads/paper.pdf
litvault scan-doi ~/Downloads/papers --json
```

`scan-doi` reports each file's chosen DOI, source, and candidates. It exits with code `2` if any file has conflicting DOI evidence.

Import-time DOI extraction uses this priority order:

1. Explicit `--doi` value.
2. PDF metadata DOI from XMP/custom fields such as `prism:doi`, `crossmark:DOI`, `pdfx:doi`, `dc:identifier`, or `WPS-ARTICLEDOI`.
3. DOI-shaped values found in PDF raw content.
4. DOI recovered from a safe filename.

When a DOI is stored, `litvault` records the source in `manifest.json` as `doiSource` and stores the candidate evidence in `doiEvidence`.

Current PDF byte scanning is lightweight:

1. Stream through the PDF bytes in chunks.
2. Decode bytes as Latin-1 so ASCII DOI strings in metadata and raw PDF content remain visible.
3. Search metadata-like DOI fields first.
4. Search with this DOI pattern:

```text
10.<4-9 digits>/<DOI suffix>
```

If no DOI is found in the PDF bytes, `litvault` falls back to the filename. This supports safe DOI filenames where the slash was replaced by an underscore or hyphen:

```text
10.1111_j.1937-5956.2000.tb00330.x.pdf -> 10.1111/j.1937-5956.2000.tb00330.x
10.1287_msom.2022.1140 (1).pdf -> 10.1287/msom.2022.1140
```

It recognizes common forms such as:

```text
10.1038/s41586-020-2649-2
doi:10.1145/3510003.3510101
https://doi.org/10.1000/xyz123
```

Limitations:

- Scanned-image PDFs are not OCRed, but they can still be imported if the filename contains a recoverable DOI.
- Compressed or deeply encoded PDF text may not be found unless the filename contains a recoverable DOI.
- A DOI hidden inside compressed streams may not be found unless the filename contains a recoverable DOI.
- If a non-literature PDF contains a DOI-shaped string, it may be imported.

The default behavior is conservative: no DOI means no import.

## DOI List Tools

Check which DOI values are not already in the vault:

```bash
litvault missing-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
litvault missing-dois --file dois.txt
```

`missing-dois` only reports DOI values. It does not create or modify records. `litvault` does not create DOI-only records because the vault is for managing PDFs.

`dois.txt` can contain one DOI per line, DOI URLs, BibTeX snippets, or pasted free-form text. `litvault` extracts DOI-looking values from the file and ignores ordinary prose.

`missing-dois` prints one normalized missing DOI per line. Use `--json` to also see DOI values that are already present or invalid.

## Stats

Show library summary:

```bash
litvault stats
```

Machine-readable output:

```bash
litvault stats --json
```

The stats command reports paper counts, DOI/PDF coverage, DOI source counts, missing stored PDFs, unique PDF objects, year range, tag/type/venue summaries, and disk usage for the manifest, object store, and whole library.

## Verify

Run a full integrity check:

```bash
litvault verify
```

Fast mode skips SHA256 re-hashing and checks structure/existence only:

```bash
litvault verify --fast
```

Machine-readable output:

```bash
litvault verify --json
```

`verify` checks that every PDF referenced by `manifest.json` exists, that stored PDFs still match their SHA256 hashes, that stored PDFs have a `%PDF-` header and `%%EOF` marker, that object PDFs are referenced by the manifest, that every record has a PDF, and that DOI/duplicate problems are not present. It returns a non-zero exit code if integrity checks fail.

## Backups

List manifest backups:

```bash
litvault backup list
```

Preview cleanup while keeping the newest 20 backups:

```bash
litvault backup prune --keep 20
```

Apply cleanup:

```bash
litvault backup prune --keep 20 --apply
```

Manifest backups are small JSON index snapshots created before commands such as `dedupe --apply` and `repair-doi --apply` modify `manifest.json`. They do not duplicate PDF objects. `backup prune` only deletes `manifest.backup-*.json` files, and it is a dry run unless `--apply` is provided.

## Safety

`litvault` is designed to avoid destructive storage behavior:

- `add` copies PDFs into the vault instead of moving source files.
- Stored PDFs are content-addressed by SHA256.
- Re-importing the same PDF bytes reuses the existing object.
- Re-importing the same DOI updates the existing record.
- `manifest.json` writes are atomic.
- `dedupe --apply` and `repair-doi --apply` create manifest backups first.
- `backup prune` is a dry run unless `--apply` is provided.

Run an integrity check after large imports or cleanup:

```bash
litvault verify
```

For long-term protection against accidental Finder or terminal deletion, back up the whole library directory with Time Machine, `rsync`, or another disk-level backup. `verify` can detect missing or modified vault PDFs, but it cannot restore files unless you have a separate backup.

## Doctor and Dedupe

Inspect possible index problems:

```bash
litvault doctor
litvault doctor --json
```

`doctor` reports duplicate PDF hash groups, duplicate DOI groups, invalid DOI values, normalizable DOI values, missing stored PDFs, invalid stored PDFs, legacy records without PDFs, records without DOIs, and records missing key metadata.

If `verify` or `doctor` reports `invalid pdf header: b'<!DOC'` or `EOF marker not found`, a `.pdf` file is usually an HTML error/login page or a truncated download. Preview removal of invalid PDF records:

```bash
litvault prune-invalid-pdfs
```

Apply after checking the preview:

```bash
litvault prune-invalid-pdfs --apply
```

Applying creates a `manifest.json` backup, removes invalid PDF records, and deletes invalid PDF objects that are no longer referenced by any remaining record.

Fill missing title, year, or author fields from DOI metadata:

```bash
litvault repair-metadata
litvault repair-metadata --apply --crossref-delay 1000 --crossref-retries 3
```

`repair-metadata` looks up records that have a DOI but are missing title, year, or authors. It fills only missing fields and does not delete records or PDFs. Use `--json` for a full machine-readable plan.

Preview DOI cleanup:

```bash
litvault repair-doi
```

Apply DOI cleanup:

```bash
litvault repair-doi --apply
```

`repair-doi` normalizes DOI values that can be safely normalized, such as `https://doi.org/...` or trailing punctuation, and clears DOI fields that still do not match the DOI pattern after normalization. It does not delete paper records or PDFs. `--apply` writes a manifest backup before changing anything.

Preview duplicate DOI cleanup:

```bash
litvault dedupe-doi
```

`dedupe-doi` auto-merges only safe duplicate DOI groups, such as records that share the same PDF hash or legacy duplicate groups where only one record has a PDF. If a duplicate DOI group has multiple different PDF hashes, it is reported as a conflict. After checking the records, resolve one conflict manually:

```bash
litvault dedupe-doi --keep 123 --remove 456
litvault dedupe-doi --keep 123 --remove 456 --apply --delete-extra-pdfs
```

Preview safe duplicate cleanup:

```bash
litvault dedupe
```

Apply safe duplicate cleanup:

```bash
litvault dedupe --apply
```

`dedupe` only auto-merges duplicate PDF-hash groups when their DOI values are compatible, meaning all records share the same DOI or only one record has a DOI. If the same PDF hash is attached to multiple different DOIs, it is reported as a conflict and left untouched.

Before applying changes, `dedupe --apply` writes a manifest backup:

```text
manifest.backup-YYYY-MM-DDTHH-MM-SS-sssZ.json
```

## Export

Export the whole library:

```bash
litvault export-bib --out all.bib
```

Export selected records:

```bash
litvault export-bib 10.1038/s41586-020-2649-2 10.1145/3510003.3510101 --out selected.bib
```

Export selected records from a query file:

```bash
litvault export-bib --file dois.txt --out selected.bib
```

Queries can be DOI, citekey, title text, or internal ID.

## Copy PDFs Out

Copy one PDF:

```bash
litvault get 10.1038/s41586-020-2649-2
```

By default, `get` copies PDFs to your current working directory. Use `--to` when you want another directory:

```bash
litvault get 10.1038/s41586-020-2649-2 --to ~/Desktop/refs
```

Copy many PDFs:

```bash
litvault get 10.1038/s41586-020-2649-2 10.1145/3510003.3510101 --to ~/Desktop/refs
```

Copy from a query file:

```bash
litvault get --file dois.txt --to ~/Desktop/refs
```

The file can contain one DOI per line, DOI URLs, BibTeX snippets, or pasted free-form text. `get --file` uses the same DOI extraction as `missing-dois --file`.

Use a filename pattern:

```bash
litvault get 10.1038/s41586-020-2649-2 --to ~/Desktop/refs --name "{year}-{first_author}-{title}.pdf"
```

Available filename fields:

```text
{id}
{doi}
{citekey}
{year}
{first_author}
{title}
```

## Notes

- DOI is normalized before storage.
- Same DOI updates the same record.
- Same PDF bytes reuse the same SHA256 object.
- BibTeX can be regenerated at any time.
- Crossref is used for metadata lookup unless `--no-crossref` is passed.
- Library selection priority is `--library`, then `LITVAULT_LIBRARY`, then `litvault config set library`, then `/Volumes/REFSSD/litvault-library`.
