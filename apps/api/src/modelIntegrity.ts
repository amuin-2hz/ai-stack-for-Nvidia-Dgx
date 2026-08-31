import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { isWeightFile } from "./utils.js";

export interface ModelIntegrityReport {
  missing_indexed_weight_files: string[];
}
export interface CompletedModelDownloadInspection {
  complete: boolean;
  reason: string;
}


export async function inspectModelIntegrity(modelPath: string, files?: string[]): Promise<ModelIntegrityReport> {
  const knownFiles = files ?? await walkFiles(modelPath);
  const indexFiles = knownFiles.filter((file) => basename(file).endsWith(".index.json"));
  const missing = new Set<string>();

  for (const indexFile of indexFiles) {
    const index = await readWeightIndex(indexFile);
    if (!index) continue;
    const indexDir = dirname(indexFile);
    for (const shard of new Set(Object.values(index.weight_map))) {
      if (typeof shard !== "string" || !shard.trim()) continue;
      const expectedPath = join(indexDir, shard);
      try {
        await access(expectedPath);
      } catch {
        missing.add(relative(modelPath, expectedPath).replace(/\\/g, "/"));
      }
    }
  }

  return { missing_indexed_weight_files: [...missing].sort() };
}
export async function inspectCompletedModelDownload(modelPath: string): Promise<CompletedModelDownloadInspection> {
  try {
    await access(join(modelPath, ".download-complete"));
  } catch {
    return { complete: false, reason: "completion marker is missing" };
  }
  const files = await walkFiles(modelPath);
  const relativeFiles = files.map((file) => relative(modelPath, file).replace(/\\/g, "/"));
  const integrity = await inspectModelIntegrity(modelPath, files);
  if (integrity.missing_indexed_weight_files.length) {
    return { complete: false, reason: "indexed weight shards are missing: " + integrity.missing_indexed_weight_files.join(", ") };
  }
  const incomplete = relativeFiles.find((file) => file.startsWith(".temp/") || /\.(part|tmp|incomplete)$/.test(file));
  if (incomplete) {
    return { complete: false, reason: "staged or partial file remains: " + incomplete };
  }
  const names = new Set(relativeFiles.map((file) => basename(file)));
  const hasConfig = ["config.json", "configuration.json", "config.yaml", "cosyvoice.yaml"].some((name) => names.has(name));
  const hasWeight = relativeFiles.some(isWeightFile);
  const standaloneWeight = relativeFiles.some((file) => /\.(gguf|engine|fst)$/.test(file));
  if (!hasWeight) return { complete: false, reason: "no model weight file was found" };
  if (!hasConfig && !standaloneWeight) return { complete: false, reason: "model configuration is missing" };
  return { complete: true, reason: "completion marker, configuration, weights and indexed shards are valid" };
}


async function readWeightIndex(path: string): Promise<{ weight_map: Record<string, string> } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { weight_map?: unknown };
    if (!parsed.weight_map || typeof parsed.weight_map !== "object" || Array.isArray(parsed.weight_map)) return undefined;
    return { weight_map: parsed.weight_map as Record<string, string> };
  } catch {
    return undefined;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  try {
    const info = await stat(root);
    if (info.isFile()) return [root];
    if (!info.isDirectory()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => walkFiles(join(root, entry.name))));
    return nested.flat();
  } catch {
    return [];
  }
}
