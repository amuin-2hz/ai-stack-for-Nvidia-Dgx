#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeRuntimeExtensions } = require("./build-runtime-extensions.js");

const repoRoot = path.resolve(__dirname, "..");
const pkg = require(path.join(repoRoot, "package.json"));
const arch = ({ arm64: "arm64", x64: "amd64" })[process.arch] || process.arch;
const debName = pkg.name + "_" + pkg.version + "_" + arch + ".deb";
const debSource = path.join(repoRoot, "dist-electron", debName);
if (!fs.existsSync(debSource)) throw new Error("Missing DEB: " + debSource);

const releaseName = pkg.name + "_" + pkg.version + "_" + arch;
const releaseRoot = path.join(repoRoot, "dist-release", releaseName);
const extensionsDir = path.join(releaseRoot, "extensions");
fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(extensionsDir, { recursive: true });
fs.copyFileSync(debSource, path.join(releaseRoot, debName));

const extensionRecords = writeRuntimeExtensions(extensionsDir);
const manifest = {
  format: "ai-stack-release/v1",
  product: pkg.build.productName,
  version: pkg.version,
  architecture: arch,
  default_runtimes: ["vllm", "trtllm", "pytorch"],
  deb: debName,
  extensions: extensionRecords
};
fs.writeFileSync(path.join(releaseRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const table = extensionRecords.map((item) =>
  "| " + item.filename + " | " + (item.category === "shared" ? "共享服务" : "专用方案") + " | " + item.title_zh + " | " + item.files + " |"
).join("\n");
const readme = [
  "# AMUIN AI STACK " + pkg.version + " 发布文件",
  "",
  "本目录可以整体复制到目标机器。DEB 只内置 vLLM、TensorRT-LLM、PyTorch 三个默认运行时；其他运行时均位于 extensions/，按需导入。",
  "",
  "## 安装",
  "",
  "在本目录执行：",
  "",
  "    sudo apt install ./" + debName,
  "",
  "## 导入扩展运行时",
  "",
  "打开“运行时”页面，进入“共享服务”或“专用方案”，点击“导入配置”，选择 extensions/ 下对应的 .aistack-runtime.json 文件。",
  "",
  "导入包是可读 JSON，能够同时携带 Compose、Dockerfile、Python、Shell 和模板文件。导入时会显示目标分类与文件数量；同名文件默认不会覆盖。",
  "",
  "| 导入包 | 分类 | 用途 | 落地文件数 |",
  "| --- | --- | --- | ---: |",
  table,
  "",
  "也可直接导入单个 .yml/.yaml Compose 文件；需要 Dockerfile 或 Python 脚本时请使用 .aistack-runtime.json 多文件包。",
  "",
  "## 校验",
  "",
  "    sha256sum -c SHA256SUMS",
  "",
  "manifest.json 供程序或发布流程读取，SHA256SUMS 用于检查复制后的文件完整性。",
  ""
].join("\n");
fs.writeFileSync(path.join(releaseRoot, "README.zh-CN.md"), readme);

const hashedFiles = [
  debName,
  ...extensionRecords.map((item) => "extensions/" + item.filename)
];
const checksums = hashedFiles.map((relativePath) => {
  const content = fs.readFileSync(path.join(releaseRoot, relativePath));
  return crypto.createHash("sha256").update(content).digest("hex") + "  " + relativePath;
}).join("\n") + "\n";
fs.writeFileSync(path.join(releaseRoot, "SHA256SUMS"), checksums);

console.log("Created release bundle " + releaseRoot);
