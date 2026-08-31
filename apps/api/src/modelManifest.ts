export interface RemoteModelFile {
  relative_path: string;
  size_bytes: number | null;
}

type HuggingFaceModelInfo = { siblings?: Array<{ rfilename?: string; size?: number }> };
type ModelScopeModelInfo = { Data?: { StorageSize?: number }; Success?: boolean };
type ModelScopeFilesInfo = { Data?: { Files?: Array<{ Path?: string; Size?: number; Type?: string }> }; Success?: boolean };

export async function fetchHuggingFaceManifest(repoId: string): Promise<RemoteModelFile[]> {
  const payload = await fetchHuggingFaceModelInfo(repoId);
  if (!payload) return [];
  return (payload.siblings ?? [])
    .filter((file) => file.rfilename && !isExcludedSnapshotFile(file.rfilename))
    .map((file) => ({ relative_path: file.rfilename as string, size_bytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null }));
}

export async function fetchHuggingFaceTotalBytes(repoId: string): Promise<number | undefined> {
  const files = await fetchHuggingFaceManifest(repoId);
  const total = files.reduce((sum, file) => sum + (Number(file.size_bytes) || 0), 0);
  return total || undefined;
}

export async function fetchModelScopeManifest(repoId: string): Promise<RemoteModelFile[]> {
  const payload = await fetchModelScopeFilesInfo(repoId);
  const files = payload?.Data?.Files ?? [];
  return files
    .filter((file) => file.Type !== "tree" && file.Path && !isExcludedModelScopeSnapshotFile(file.Path))
    .map((file) => ({ relative_path: file.Path as string, size_bytes: Number.isFinite(Number(file.Size)) ? Number(file.Size) : null }));
}

export async function fetchModelScopeTotalBytes(repoId: string): Promise<number | undefined> {
  const files = await fetchModelScopeManifest(repoId);
  const total = files.reduce((sum, file) => sum + (Number(file.size_bytes) || 0), 0);
  if (total) return total;
  const payload = await fetchModelScopeModelInfo(repoId);
  const storageSize = Number(payload?.Data?.StorageSize);
  return Number.isFinite(storageSize) && storageSize > 0 ? storageSize : undefined;
}

async function fetchHuggingFaceModelInfo(repoId: string): Promise<HuggingFaceModelInfo | undefined> {
  return fetchJson<HuggingFaceModelInfo>(huggingFaceModelInfoUrl(repoId));
}

async function fetchModelScopeFilesInfo(repoId: string): Promise<ModelScopeFilesInfo | undefined> {
  return fetchJson<ModelScopeFilesInfo>(modelScopeFilesUrl(repoId));
}

async function fetchModelScopeModelInfo(repoId: string): Promise<ModelScopeModelInfo | undefined> {
  return fetchJson<ModelScopeModelInfo>(modelScopeModelInfoUrl(repoId));
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json() as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function huggingFaceModelInfoUrl(repoId: string): string {
  return "https://huggingface.co/api/models/" + encodeRepoPath(repoId) + "?blobs=true";
}

function modelScopeFilesUrl(repoId: string): string {
  return "https://modelscope.cn/api/v1/models/" + encodeRepoPath(repoId) + "/repo/files?Revision=master&Recursive=true";
}

function modelScopeModelInfoUrl(repoId: string): string {
  return "https://modelscope.cn/api/v1/models/" + encodeRepoPath(repoId);
}

function encodeRepoPath(repoId: string): string {
  return encodeURIComponent(repoId.replace(/\.git$/, "")).replace(/%2F/g, "/");
}

export function isExcludedSnapshotFile(name: string): boolean {
  return name.startsWith(".git/") || name.startsWith(".cache/") || name.includes("/.git/") || /\.(msgpack|h5|ckpt|tflite|pb|flax|ot)$/.test(name);
}

function isExcludedModelScopeSnapshotFile(name: string): boolean {
  return name === ".gitattributes" || name.startsWith(".git/") || name.includes("/.git/");
}
