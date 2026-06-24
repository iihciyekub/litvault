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

它是一个命令行文献库工具。你把 PDF 或 DOI 丢给它，它帮你识别 DOI、查元数据、去重、存档、导出 PDF、导出 BibTeX，并且可以随时体检整个库有没有文件丢失或被改坏。

一句话：

```text
litvault = 以 DOI 为核心的本地论文 PDF 保险库
```

它不需要 Python，不需要 SQLite，也不强迫你使用 Zotero。所有数据都放在你自己的磁盘上。

## 它能帮你做什么

### 1. 把 PDF 收进统一文献库

单篇导入：

```bash
litvault add ~/Downloads/paper.pdf
```

整个目录导入：

```bash
litvault add /Volumes/LYSSSD/DID_2164
```

`litvault` 会只处理 PDF，并尽力找到 DOI。找到 DOI 后，它会把 PDF 复制进文献库，不会移动你的原文件。

### 2. 自动识别 DOI，不只看文件名

导入时，它会按这个顺序找 DOI：

```text
1. 你手动传入的 --doi
2. PDF 内部 metadata，比如 prism:doi / crossmark:DOI / dc:identifier
3. PDF 原始内容里的 DOI
4. 文件名里的 DOI，比如 10.1111_xxx.pdf
```

比如这个文件名：

```text
10.1111_j.1937-5956.2000.tb00330.x.pdf
```

会被识别成：

```text
10.1111/j.1937-5956.2000.tb00330.x
```

如果 PDF 内部 DOI 和文件名 DOI 打架，`litvault` 不会瞎猜，会跳过并报告冲突。

### 3. 导入前先检查 DOI 来源

不想直接入库？可以先扫描：

```bash
litvault scan-doi ~/Downloads/paper.pdf
```

扫目录：

```bash
litvault scan-doi /Volumes/LYSSSD/DID_2164
```

它会告诉你每篇 PDF 的 DOI 是从哪里来的：

```text
DOI: 10.1111/j.1937-5956.2000.tb00330.x
Source: pdf-metadata
Candidates:
  pdf-metadata: ...
  pdf-content: ...
  filename: ...
```

这对大批量导入特别有用。先看清楚，再动手。

### 4. 自动去重，不重复收同一份 PDF

`litvault` 会给 PDF 算 SHA256。

也就是说，同一份 PDF 哪怕文件名不同：

```text
paper.pdf
paper (1).pdf
10.1111_xxx.pdf
```

只要内容完全一样，它就知道这是同一个 PDF。

目录导入时，它会先建立内存索引，快速跳过已经入库的 PDF，而不是一条条慢慢查。

### 5. 用 DOI 把 PDF 拿出来

在当前目录导出一篇：

```bash
litvault get 10.1287/isre.2023.0332
```

导出到指定目录：

```bash
litvault get 10.1287/isre.2023.0332 --to ~/Desktop/refs
```

批量导出：

```bash
litvault get 10.1287/isre.2023.0332 10.1287/mksc.2022.0212 --to ~/Desktop/refs
```

### 6. 导出 BibTeX

整个库导出：

```bash
litvault export-bib --out references.bib
```

只导出几篇：

```bash
litvault export-bib 10.1287/isre.2023.0332 --out selected.bib
```

### 7. 随时体检文献库

这条命令很重要：

```bash
litvault verify
```

它会检查：

```text
manifest.json 里引用的 PDF 是否真的存在
PDF 内容 SHA256 是否还匹配
有没有孤儿 PDF
有没有重复 DOI
有没有重复 PDF hash
有没有不合规 DOI
```

如果你担心“文件是不是被我误删了”“库是不是坏了”，就跑它。

快速检查：

```bash
litvault verify --fast
```

### 8. 看库里现在是什么状态

```bash
litvault stats
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

### 9. 修复、去重前会留索引备份

这些命令会改 `manifest.json`：

```bash
litvault repair-doi --apply
litvault dedupe --apply
```

执行前会自动生成：

```text
manifest.backup-YYYY-MM-DDTHH-MM-SS-sssZ.json
```

这些只是索引备份，不会复制 PDF，所以通常很小。

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

默认 dry-run，不加 `--apply` 不删东西。

## 安装

从 GitHub 安装最新版：

```bash
npm install -g github:iihciyekub/litvault#v0.1.15
```

检查版本：

```bash
litvault --version
```

## 初始化

默认库位置是：

```text
~/litvault-library
```

初始化：

```bash
litvault init
```

如果你想把 PDF 放移动 SSD，非常推荐这样：

```bash
litvault config set library /Volumes/LYSSSD/litvault-library
litvault init
```

以后所有命令默认都会用这个库。

查看当前配置：

```bash
litvault config get
```

## 文献库长什么样

新库很简单：

```text
litvault-library/
  manifest.json
  objects/
    sha256/
```

`manifest.json` 是索引，记录 DOI、标题、作者、年份、PDF hash 等。

`objects/sha256/` 是真正存 PDF 的地方。PDF 按内容 hash 存，不靠文件名判断身份。

## 推荐工作流

第一次配置：

```bash
litvault config set library /Volumes/LYSSSD/litvault-library
litvault init
```

导入前先扫一遍：

```bash
litvault scan-doi /Volumes/LYSSSD/DID_2164
```

正式导入：

```bash
litvault add /Volumes/LYSSSD/DID_2164
```

如果只想快速入库，不查 Crossref 元数据：

```bash
litvault add /Volumes/LYSSSD/DID_2164 --no-crossref
```

导入后体检：

```bash
litvault verify
litvault stats
```

以后找 PDF：

```bash
litvault get DOI
```

导出引用：

```bash
litvault export-bib --out refs.bib
```

## 它为什么比较稳

`litvault` 的设计目标不是花哨，而是让你少担心。

它做了这些事：

```text
导入 PDF 是复制，不移动原文件
同一 PDF 用 SHA256 去重
同一 DOI 更新同一条记录
manifest.json 原子写入
修复和去重前自动备份 manifest
verify 可以检查 PDF 是否缺失或被改
backup prune 默认不删除，必须 --apply
```

但它不是完整备份系统。

如果你在 Finder 或终端里手动删掉整个 `objects/`，`litvault verify` 能发现问题，但不能凭空恢复文件。

长期安全建议：

```bash
litvault verify
```

再配合 Time Machine、`rsync`，或者另一个硬盘备份整个：

```text
/Volumes/LYSSSD/litvault-library
```

## 一句话总结

`litvault` 不是帮你“再建一个混乱文件夹”。

它是把 PDF、DOI、引用信息和完整性检查放在一起，让你的论文库变成一个可以长期维护、可以验证、可以导出的本地文献保险库。
