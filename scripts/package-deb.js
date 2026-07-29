#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const pkg = require(path.join(repoRoot, "package.json"));

const debArchByNodeArch = {
  arm64: "arm64",
  x64: "amd64",
};

const arch = debArchByNodeArch[process.arch] ?? process.arch;
const productName = pkg.build?.productName ?? pkg.productName ?? pkg.name;
const packageName = pkg.name;
const outputDir = path.join(repoRoot, pkg.build?.directories?.output ?? "dist-electron");
const unpackedDir = path.join(outputDir, `linux-${process.arch}-unpacked`);
const debRoot = path.join(outputDir, "deb-root");
const appDest = path.join(debRoot, "opt", productName);
const debPath = path.join(outputDir, `${packageName}_${pkg.version}_${arch}.deb`);

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return false;
  mkdirp(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function normalizePermissions(root) {
  const executableNames = new Set([packageName, "chrome-sandbox", "chrome_crashpad_handler"]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(full, 0o755);
      normalizePermissions(full);
    } else if (entry.isFile()) {
      const executable = full.startsWith(path.join(debRoot, "usr", "bin")) || executableNames.has(entry.name) || full.includes(`${path.sep}ops${path.sep}scripts${path.sep}`) && entry.name.endsWith(".sh");
      fs.chmodSync(full, executable ? 0o755 : 0o644);
    }
  }
}

if (!fs.existsSync(unpackedDir)) {
  throw new Error(`Missing Electron output directory: ${unpackedDir}`);
}

fs.rmSync(debRoot, { recursive: true, force: true });
mkdirp(path.dirname(appDest));
fs.cpSync(unpackedDir, appDest, { recursive: true });

mkdirp(path.join(debRoot, "DEBIAN"));
mkdirp(path.join(debRoot, "usr", "bin"));
writeExecutable(
  path.join(debRoot, "usr", "bin", packageName),
  `#!/bin/sh\nexec "/opt/${productName}/${packageName}" "$@"\n`
);

mkdirp(path.join(debRoot, "usr", "share", "applications"));
fs.writeFileSync(
  path.join(debRoot, "usr", "share", "applications", `${packageName}.desktop`),
  [
    "[Desktop Entry]",
    `Name=${productName}`,
    "Comment=Local AI model workbench for DGX Spark",
    `Exec=/usr/bin/${packageName} %U`,
    "Terminal=false",
    "Type=Application",
    `Icon=${packageName}`,
    "Categories=Science;Development;",
    "",
  ].join("\n")
);

copyIfExists(
  path.join(repoRoot, "node_modules", "app-builder-lib", "templates", "icons", "electron-linux", "256x256.png"),
  path.join(debRoot, "usr", "share", "icons", "hicolor", "256x256", "apps", `${packageName}.png`)
);

const depends = pkg.build?.deb?.depends?.join(", ") ?? "";
const control = [
  `Package: ${packageName}`,
  `Version: ${pkg.version}`,
  "Section: science",
  "Priority: optional",
  `Architecture: ${arch}`,
  "Maintainer: AMUIN <amuin@example.com>",
  depends ? `Depends: ${depends}` : null,
  `Homepage: ${pkg.homepage ?? "https://amuin.ai"}`,
  `Description: ${pkg.description ?? productName}`,
  ` ${productName} provides an Electron desktop console for local model downloads, runtime orchestration, and OpenAI-compatible serving on DGX Spark.`,
].filter(Boolean).join("\n") + "\n";
fs.writeFileSync(path.join(debRoot, "DEBIAN", "control"), control);

normalizePermissions(debRoot);
mkdirp(outputDir);
const result = spawnSync("dpkg-deb", ["--root-owner-group", "--build", debRoot, debPath], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Created ${debPath}`);
