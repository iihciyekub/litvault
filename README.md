# litvault：把散落的论文 PDF 收进一个可靠的小金库

中文 | [English](README.en.md)

如果你的论文 PDF 曾经长这样：

```text
Downloads/
Desktop/
某个项目文件夹/
移动硬盘/不知道哪一层/又一个 papers/
10.1287_msom.2022.1140 (1).pdf
final_final_really_final.pdf
```

那 `litvault` 就是给这种场面准备的。

它是一个以 DOI 为核心的本地文献库命令行工具。你把 PDF 或 DOI 丢给它，它会帮你识别 DOI、查询元数据、去重、存档、找回 PDF、导出 BibTeX，并且可以随时检查整个库有没有文件丢失或被改坏。

一句话：

```text
litvault = 以 DOI 为身份核心的本地论文 PDF 保险库
```

它不需要 Python，不需要 SQLite，也不强迫你使用 Zotero。所有数据都放在你自己的磁盘上。

## 适合哪些场景

`litvault` 特别适合这些日常研究场面：

- 你从浏览器、邮件、网盘、移动硬盘里攒了很多 PDF，想统一收进一个长期可维护的库。
- 你有一批 DOI，想知道哪些论文已经有 PDF，哪些还缺。
- 你写论文或做项目时，需要把指定 DOI 的 PDF 批量拷贝到一个文件夹给自己、同事或审稿附件整理使用。
- 你想从本地库重新生成 BibTeX，而不是到处翻网页。
- 你担心移动硬盘上的文献库被误删、重复导入或索引损坏，想定期体检。

它不是完整的文献管理器，也不是备份系统。它更像一个朴素但可靠的 PDF 仓库：把 DOI、PDF、引用元数据和完整性检查放在一起。

## 安装

需要 Node.js 18 或更新版本。

从 GitHub 安装最新发布版本：

```bash
npm install -g github:iihciyekub/litvault#semver:*
litvault --help
```

这条命令会选择仓库里最新的语义化版本标签。以后发布新版本后，不需要改版本号，重新运行同一条命令即可安装最新版本。

安装后也可以用短命令 `lv`，它和 `litvault` 完全等价：

```bash
lv --help
lv doctor
```

检查版本：

```bash
litvault --version
```

从 GitHub 更新：

```bash
litvault update
```

只检查或预演更新，不真正安装：

```bash
litvault update --check
litvault update --dry-run
```

在本仓库里本地开发时：

```bash
cd /Users/iipro/iiresearch/litvault
npm install -g .
litvault --help
```

或者不全局安装，直接运行：

```bash
bin/litvault --help
```

## 第一次使用

默认文献库位置是：

```text
/Volumes/REFSSD/litvault-library
```

如果你刚好就想把库放在这个移动硬盘路径，直接初始化即可：

```bash
litvault init
```

更推荐先显式配置一次库位置。比如你有一个专门放研究资料的外接 SSD：

```bash
litvault config set library /Volumes/REFSSD/litvault-library
litvault init
```

以后普通命令都会默认使用这个库：

```bash
litvault add ~/Downloads/paper.pdf
litvault list
```

查看当前配置：

```bash
litvault config get
```

临时改用另一个库：

```bash
litvault --library /path/to/other-library list
```

也可以用环境变量：

```bash
LITVAULT_LIBRARY=/Volumes/REFSSD/litvault-library litvault stats
```

库目录长这样：

```text
litvault-library/
  manifest.json
  objects/
    sha256/
```

`manifest.json` 是索引，记录 DOI、标题、作者、年份、标签、PDF hash 等信息。`objects/sha256/` 是真正保存 PDF 的地方，PDF 按内容 SHA256 存放，不靠文件名判断身份。

库选择优先级是：

```text
--library 参数 > LITVAULT_LIBRARY 环境变量 > litvault config set library > 内置默认路径
```

## 快速开始

```bash
litvault init
litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
litvault add ~/Downloads/papers
litvault scan-doi ~/Downloads/papers
litvault missing-dois --file dois.txt
litvault search transformer
litvault info 10.1038/s41586-020-2649-2
litvault get --file dois.txt --to ~/Desktop/refs
litvault export-bib --out ~/Desktop/references.bib
litvault verify
```

## 导入 PDF

导入单篇 PDF，并手动指定 DOI：

```bash
litvault add ~/Downloads/paper.pdf --doi 10.1038/s41586-020-2649-2
```

导入单篇 PDF，让 `litvault` 自己识别 DOI：

```bash
litvault add ~/Downloads/paper.pdf
```

导入整个目录，默认递归处理子目录里的 PDF：

```bash
litvault add ~/Downloads/papers
```

只处理当前目录，不进入子目录：

```bash
litvault add ~/Downloads/papers --no-recursive
```

给导入的论文加标签：

```bash
litvault add ~/Downloads/papers --tag ai --tag methods
```

跳过 Crossref 元数据查询，只做 DOI 和 PDF 入库：

```bash
litvault add ~/Downloads/papers --no-crossref
```

如果导入几千篇 PDF，担心 Crossref 限流，可以放慢请求并重试：

```bash
litvault add /Volumes/REFSSD/raw-papers --crossref-delay 1000 --crossref-retries 3
```

目录导入时，`litvault` 只处理 `.pdf` 文件。没有 DOI 的 PDF 会被跳过并报告，不会硬塞进库。

### 场景：整理 Downloads 里的论文

```bash
litvault scan-doi ~/Downloads
litvault add ~/Downloads
litvault stats
litvault verify
```

这个流程适合先看 DOI 识别情况，再正式入库。`add` 是复制 PDF，不会移动或删除你 Downloads 里的原文件。

### 场景：导入移动硬盘上的旧论文包

```bash
litvault config set library /Volumes/REFSSD/litvault-library
litvault init
litvault scan-doi /Volumes/REFSSD/old_papers --no-recursive
litvault add /Volumes/REFSSD/old_papers --no-crossref --verbose
```

如果只是想先把 PDF 安全收进库，可以用 `--no-crossref`。之后再用 `repair-metadata --apply` 补元数据。

## DOI 怎么识别

导入时，`litvault` 按这个顺序找 DOI：

```text
1. 你手动传入的 --doi
2. PDF 内部 metadata，比如 prism:doi、crossmark:DOI、pdfx:doi、dc:identifier
3. PDF 原始内容里的 DOI
4. 文件名里的 DOI，比如 10.1111_xxx.pdf
```

常见 DOI 写法都能处理：

```text
10.1038/s41586-020-2649-2
doi:10.1145/3510003.3510101
https://doi.org/10.1000/xyz123
```

文件名里的安全写法也能恢复：

```text
10.1111_j.1937-5956.2000.tb00330.x.pdf
```

会被识别成：

```text
10.1111/j.1937-5956.2000.tb00330.x
```

如果 PDF 内部 DOI 和文件名 DOI 打架，`litvault` 不会瞎猜，会跳过并报告冲突。

### 先扫描，不入库

```bash
litvault scan-doi ~/Downloads/paper.pdf
litvault scan-doi ~/Downloads/papers
litvault scan-doi ~/Downloads/papers --json
```

输出会告诉你每个 PDF 的 DOI 来源和候选证据：

```text
DOI: 10.1111/j.1937-5956.2000.tb00330.x
Source: pdf-metadata
Candidates:
  pdf-metadata: ...
  pdf-content: ...
  filename: ...
```

如果你准备大批量导入，建议先跑 `scan-doi`。这一步不会修改文献库。

### 识别限制

- 扫描版 PDF 不会 OCR；如果文件名里没有可恢复 DOI，可能无法识别。
- PDF 内部文字被深度压缩或编码时，可能识别不到正文里的 DOI。
- 非论文 PDF 里如果刚好有 DOI 形状的字符串，也可能被识别出来。

默认策略是保守的：没有 DOI，就不导入。

## DOI 清单工具

检查一批 DOI 哪些还没入库：

```bash
litvault missing-dois 10.1287/isre.2023.0332 10.1287/mksc.2022.0212
litvault missing-dois --file dois.txt
```

`dois.txt` 不必严格一行一个 DOI；可以是 DOI URL、BibTeX 片段、网页上复制下来的引用文本。普通说明文字会被忽略。

例如文件里可以这样写：

```text
Already downloaded: https://doi.org/10.1287/isre.2023.0332
Need to read:
doi = {10.1145/3510003.3510101},
10.1002/smj.3512.
```

输出默认是一行一个未入库 DOI，适合继续传给下载脚本或手动查找：

```bash
litvault missing-dois --file dois.txt
```

如果想同时看到已存在、缺失、无效 DOI：

```bash
litvault missing-dois --file dois.txt --json
```

### 场景：老师给了一份阅读清单

```bash
litvault missing-dois --file seminar-reading-list.txt --json
litvault get --file seminar-reading-list.txt --to ~/Desktop/seminar-pdfs
```

第一条命令告诉你哪些 DOI 已经在库里，哪些还缺。第二条命令把已经有 PDF 的论文拷出来，方便同步到课程文件夹。

### DOI 清单只做缺口检查

`litvault` 不创建只有 DOI、没有 PDF 的记录。它的定位是管理 PDF 文献库，所以 DOI 清单只用于检查缺口：

```bash
litvault missing-dois --file todo-dois.txt
```

等你拿到 PDF 后，再把 PDF 加进库：

```bash
litvault add ~/Downloads/paper.pdf
```

## 找回和复制 PDF

把一篇 PDF 复制到当前目录：

```bash
litvault get 10.1287/isre.2023.0332
```

复制到指定目录：

```bash
litvault get 10.1287/isre.2023.0332 --to ~/Desktop/refs
```

批量复制：

```bash
litvault get 10.1287/isre.2023.0332 10.1287/mksc.2022.0212 --to ~/Desktop/refs
```

从文件批量复制：

```bash
litvault get --file dois.txt --to ~/Desktop/refs
```

自定义导出文件名：

```bash
litvault get 10.1038/s41586-020-2649-2 --to ~/Desktop/refs --name "{year}-{first_author}-{title}.pdf"
```

可用字段：

```text
{id}
{doi}
{citekey}
{year}
{first_author}
{title}
```

### 场景：给合作者打包本周要读的论文

```bash
litvault get --file weekly-reading-dois.txt --to ~/Desktop/weekly-reading --name "{year}-{first_author}-{title}.pdf"
litvault export-bib --file weekly-reading-dois.txt --out ~/Desktop/weekly-reading/refs.bib
```

这样目录里既有 PDF，也有对应 BibTeX。

## 搜索、查看和列出记录

按标题、作者、venue、DOI 等文本搜索：

```bash
litvault search transformer
litvault search "information systems" --limit 20
```

查看单条记录详情：

```bash
litvault info 10.1038/s41586-020-2649-2
```

列出最近记录：

```bash
litvault list
litvault list --limit 50
```

这些命令不会修改库，适合日常确认“这篇到底有没有收进去”。

## 导出 BibTeX

导出整个库：

```bash
litvault export-bib --out references.bib
```

只导出几篇：

```bash
litvault export-bib 10.1287/isre.2023.0332 10.1287/mksc.2022.0212 --out selected.bib
```

从文件导出：

```bash
litvault export-bib --file dois.txt --out selected.bib
```

查询可以是 DOI、citekey、标题片段或内部 ID。

### 场景：论文投稿前整理引用

```bash
litvault missing-dois --file manuscript.bib
litvault export-bib --file manuscript.bib --out manuscript-litvault.bib
litvault get --file manuscript.bib --to ~/Desktop/manuscript-pdfs
```

这个流程可以帮你确认 BibTeX 里的 DOI 哪些缺 PDF，同时把库里已有 PDF 和干净的 BibTeX 导出来。

## 统计和体检

查看库状态：

```bash
litvault stats
litvault stats --json
```

你会看到类似：

```text
Papers: 103
With DOI: 103
With PDF: 103
Missing stored PDFs: 0
Duplicate DOI values: 0
Duplicate PDF hashes: 0
DOI sources:
  pdf-metadata: ...
  filename: ...
```

完整体检：

```bash
litvault verify
```

快速体检，跳过 PDF SHA256 重算：

```bash
litvault verify --fast
```

机器可读输出：

```bash
litvault verify --json
```

`verify` 会检查：

```text
manifest.json 里引用的 PDF 是否真的存在
PDF 是否真的有 `%PDF-` 文件头和 `%%EOF` 结束标记
PDF 内容 SHA256 是否还匹配
有没有孤儿 PDF
有没有重复 DOI
有没有重复 PDF hash
有没有不合规 DOI
有没有遗留的无 PDF 记录
```

### 场景：大批量导入之后确认库没坏

```bash
litvault add /Volumes/REFSSD/new-batch
litvault stats
litvault verify
```

如果 `verify` 通过，至少说明索引和对象文件能互相对上。

## 修复和去重

先检查潜在问题：

```bash
litvault doctor
litvault doctor --json
```

如果 `verify` 或 `doctor` 报告 `invalid pdf header: b'<!DOC'` 或 `EOF marker not found`，通常表示某个 `.pdf` 实际是 HTML 错误页、登录页，或下载中断的截断文件。先预览要剔除的坏 PDF 记录：

```bash
litvault prune-invalid-pdfs
```

确认预览后再应用：

```bash
litvault prune-invalid-pdfs --apply
```

应用时会先备份 `manifest.json`，再删除坏记录，并删除不再被任何记录引用的坏 PDF 对象。

补全缺失的标题、年份、作者：

```bash
litvault repair-metadata
litvault repair-metadata --apply
```

`repair-metadata` 只补缺失字段，不会删除记录或 PDF。预览没问题后再加 `--apply`。

清理可以安全规范化的 DOI：

```bash
litvault repair-doi
litvault repair-doi --apply
```

清理重复 DOI：

```bash
litvault dedupe-doi
litvault dedupe-doi --apply
```

`dedupe-doi` 只会自动合并安全的重复 DOI。如果同一个 DOI 下有不同 PDF，它会报告冲突，需要你指定保留哪条：

```bash
litvault dedupe-doi --keep 123 --remove 456
litvault dedupe-doi --keep 123 --remove 456 --apply --delete-extra-pdfs
```

按 PDF hash 清理安全重复记录：

```bash
litvault dedupe
litvault dedupe --apply
```

`dedupe` 只会自动合并 DOI 兼容的重复 PDF hash。如果同一份 PDF 被挂在多个不同 DOI 下，它会保留冲突并报告。

### 场景：你不小心重复导入了几次同一个文件夹

```bash
litvault doctor
litvault dedupe
litvault dedupe --apply
litvault verify
```

先用 `doctor` 和 `dedupe` 看计划，再真正应用。最后用 `verify` 确认库仍然一致。

## 备份索引

这些命令会改 `manifest.json`：

```bash
litvault repair-doi --apply
litvault dedupe-doi --apply
litvault dedupe --apply
```

应用前会自动生成索引备份：

```text
manifest.backup-YYYY-MM-DDTHH-MM-SS-sssZ.json
```

这些只是 `manifest.json` 的备份，不会复制 PDF，所以通常很小。

查看备份：

```bash
litvault backup list
```

清理旧备份，先预览：

```bash
litvault backup prune --keep 20
```

真正删除：

```bash
litvault backup prune --keep 20 --apply
```

`backup prune` 默认是 dry run，不加 `--apply` 不删东西。

## 为什么比较稳

`litvault` 的设计目标不是花哨，而是让你少担心：

```text
导入 PDF 是复制，不移动原文件
同一 PDF 用 SHA256 去重
同一 DOI 更新同一条记录
manifest.json 原子写入
修复和去重前自动备份 manifest
verify 可以检查 PDF 是否缺失或被改
backup prune 默认不删除，必须 --apply
```

但它不是完整备份系统。如果你在 Finder 或终端里手动删掉整个 `objects/`，`litvault verify` 能发现问题，但不能凭空恢复文件。

长期安全建议是定期运行：

```bash
litvault verify
```

并配合 Time Machine、`rsync` 或另一个硬盘备份整个库目录：

```text
/Volumes/REFSSD/litvault-library
```

## 命令总览

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

## 一句话总结

`litvault` 不是帮你再建一个混乱文件夹。

它是把 PDF、DOI、引用信息和完整性检查放在一起，让你的论文库变成一个可以长期维护、可以验证、可以导出的本地文献保险库。
