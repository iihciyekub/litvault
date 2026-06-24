# litvault

`litvault` is a DOI-centered local literature vault CLI.

It is implemented in Node.js, installs with npm, stores metadata in a local `manifest.json`, and stores PDFs by SHA256 content hash.

## Install

From this project directory:

```bash
cd /Users/iipro/iiresearch/litvault
npm install -g .
litvault --help
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

After npm publication:

```bash
npm install -g litvault
litvault --help
```

## Storage

By default, the library lives at:

```text
~/litvault-library/
  manifest.json
  objects/
    sha256/
  exports/
  notes/
```

Use another library directory once:

```bash
litvault --library /path/to/library init
```

Set a persistent default library, for example on an external SSD:

```bash
litvault config set library /Volumes/ResearchSSD/litvault-library
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
litvault --library ~/litvault-library list
```

You can also use an environment variable:

```bash
LITVAULT_LIBRARY=/Volumes/ResearchSSD/litvault-library litvault add ~/Downloads/papers
```

The DOI is the main identity key. If you import the same DOI again, `litvault` updates the existing record instead of creating a duplicate.

The PDF object store is content-addressed. If the exact same PDF bytes are imported again, the stored PDF object is reused.

Directory imports use in-memory indexes for fast deduplication. On `litvault add DIR`, the CLI loads the manifest once, builds DOI and PDF-hash maps, skips PDFs already stored by SHA256, skips duplicate files within the same input batch, and writes the manifest once at the end.

## Quick Start

```bash
litvault init
litvault config set library /Volumes/ResearchSSD/litvault-library
litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
litvault add ~/Downloads/papers
litvault import-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
litvault search transformer
litvault stats
litvault info 10.1038/s41586-020-2649-2
litvault get 10.1038/s41586-020-2649-2
litvault export-bib --out ~/Desktop/references.bib
```

## Commands

```bash
litvault [--library DIR] init [DIR]
litvault [--library DIR] add FILE_OR_DIR... [--doi DOI] [--title TITLE] [--tag TAG] [--no-crossref] [--no-recursive] [--quiet] [--verbose]
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

When importing a directory, `litvault` only processes `.pdf` files. A PDF is imported only if a DOI is found in the PDF text or can be recovered from a DOI-shaped filename. Files without a DOI are skipped and reported.

During directory import, existing PDFs are skipped before metadata lookup. If a PDF is new but its DOI already exists in the vault, the existing record is updated with the new PDF instead of creating another record.

Default directory imports show a compact progress line and a final summary. Use `--verbose` to print every stored/skipped file, or `--quiet` to print only the final summary:

```bash
litvault add ~/Downloads/papers --verbose
litvault add ~/Downloads/papers --quiet
```

## DOI Scanning

Current DOI scanning is lightweight:

1. Read the first 4 MB of the PDF file.
2. Decode those bytes as UTF-8.
3. If no DOI is found, decode as Latin-1.
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
- A DOI outside the first 4 MB may not be found unless the filename contains a recoverable DOI.
- If a non-literature PDF contains a DOI-shaped string, it may be imported.

The default behavior is conservative: no DOI means no import.

## Import DOI Lists

Import metadata for many DOIs without PDFs:

```bash
litvault import-dois 10.1038/s41586-020-2649-2 10.1145/3510003.3510101
```

Import from a text file:

```bash
litvault import-dois --file dois.txt
```

`dois.txt` can contain one DOI per line. Empty lines and lines starting with `#` are ignored.

## Export

## Stats

Show library summary:

```bash
litvault stats
```

Machine-readable output:

```bash
litvault stats --json
```

The stats command reports paper counts, DOI/PDF coverage, missing stored PDFs, unique PDF objects, year range, tag/type/venue summaries, and disk usage for the manifest, object store, and whole library.

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

`verify` checks that every PDF referenced by `manifest.json` exists, that stored PDFs still match their SHA256 hashes, that object PDFs are referenced by the manifest, and that DOI/duplicate problems are not present. It returns a non-zero exit code if integrity checks fail.

## Doctor and Dedupe

Inspect possible index problems:

```bash
litvault doctor
litvault doctor --json
```

`doctor` reports duplicate PDF hash groups, duplicate DOI groups, invalid DOI values, normalizable DOI values, missing stored PDFs, records without PDFs, records without DOIs, and records missing key metadata.

Preview DOI cleanup:

```bash
litvault repair-doi
```

Apply DOI cleanup:

```bash
litvault repair-doi --apply
```

`repair-doi` normalizes DOI values that can be safely normalized, such as `https://doi.org/...` or trailing punctuation, and clears DOI fields that still do not match the DOI pattern after normalization. It does not delete paper records or PDFs. `--apply` writes a manifest backup before changing anything.

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

## Zotero Sync

`litvault sync zotero` imports DOI-backed top-level Zotero items through Zotero's local API.

Before syncing:

1. Start Zotero.
2. Enable local API access in Zotero settings.
3. Run:

```bash
litvault sync zotero --dry-run
litvault sync zotero
```

Metadata and available PDF attachments are imported into `litvault`.

Skip PDF attachment copying:

```bash
litvault sync zotero --no-copy-pdfs
```

Import from another Zotero library path:

```bash
litvault sync zotero --zotero-library groups/123456
```

The current sync direction is Zotero -> litvault. Local write-back into Zotero is intentionally not included in v0.1.

## Notes

- DOI is normalized before storage.
- Same DOI updates the same record.
- Same PDF bytes reuse the same SHA256 object.
- BibTeX can be regenerated at any time.
- Crossref is used for metadata lookup unless `--no-crossref` is passed.
- Library selection priority is `--library`, then `LITVAULT_LIBRARY`, then `litvault config set library`, then `~/litvault-library`.
