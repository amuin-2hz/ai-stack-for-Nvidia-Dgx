import { parse as parseYaml } from "yaml";

export type RuntimeExtensionCategory = "shared" | "dedicated";

export type RuntimeExtensionImport = {
  id: string;
  category: RuntimeExtensionCategory;
  title: string;
  title_zh: string;
  description: string;
  description_zh: string;
  suitable_models: string[];
  compose: string;
  files: Array<{ path: string; content: string }>;
};

function normalizedId(value: string): string {
  const id = value.trim().toLowerCase()
    .replace(/^docker-compose\./, "")
    .replace(/\.aistack-runtime\.json$/, "")
    .replace(/\.(ya?ml|json)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Runtime extension id is missing.");
  return id;
}

function normalizedCategory(value: unknown, fallback: RuntimeExtensionCategory): RuntimeExtensionCategory {
  return value === "shared" || value === "dedicated" ? value : fallback;
}

function validateCompose(source: string): string {
  const compose = source.trim();
  if (!compose) throw new Error("Runtime extension has no Compose YAML.");
  const parsed = parseYaml(compose) as any;
  if (!parsed?.services || typeof parsed.services !== "object" || !Object.keys(parsed.services).length) {
    throw new Error("Compose YAML must define at least one service.");
  }
  return compose + "\n";
}

export function isAllowedRuntimeExtensionFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return /^(deploy\/dockerfiles\/custom\/|deploy\/templates\/|ops\/scripts\/)[a-zA-Z0-9._/-]+$/.test(normalized)
    && !normalized.split("/").includes("..");
}

export function parseRuntimeExtensionImport(
  filename: string,
  content: Buffer,
  requestedCategory?: RuntimeExtensionCategory
): RuntimeExtensionImport {
  if (!content.length) throw new Error("Runtime extension file is empty.");
  if (content.length > 8 * 1024 * 1024) throw new Error("Runtime extension file exceeds the 8 MiB limit.");
  const text = content.toString("utf-8");
  if (/\.ya?ml$/i.test(filename)) {
    const id = normalizedId(filename);
    return {
      id,
      category: requestedCategory ?? "dedicated",
      title: id,
      title_zh: id,
      description: "Imported Docker Compose runtime profile.",
      description_zh: "导入的 Docker Compose 运行时方案。",
      suitable_models: [],
      compose: validateCompose(text),
      files: []
    };
  }

  let document: any;
  try { document = JSON.parse(text); }
  catch { throw new Error("Extension package must be Compose YAML or ai-stack-runtime/v1 JSON."); }
  if (document?.format !== "ai-stack-runtime/v1") throw new Error("Unsupported runtime extension package format.");
  const manifest = document.manifest ?? {};
  const id = normalizedId(String(manifest.id ?? filename));
  const files = (Array.isArray(document.files) ? document.files : []).map((item: any) => ({
    path: String(item?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, ""),
    content: String(item?.content ?? "")
  }));
  for (const file of files) {
    if (!file.path || !isAllowedRuntimeExtensionFile(file.path)) throw new Error("Extension contains a disallowed file path: " + file.path);
  }
  return {
    id,
    category: requestedCategory ?? normalizedCategory(manifest.category, "dedicated"),
    title: String(manifest.title ?? id).trim().slice(0, 80) || id,
    title_zh: String(manifest.title_zh ?? manifest.title ?? id).trim().slice(0, 80) || id,
    description: String(manifest.description ?? "Imported runtime extension.").trim().slice(0, 500),
    description_zh: String(manifest.description_zh ?? manifest.description ?? "导入的运行时扩展。").trim().slice(0, 500),
    suitable_models: [...new Set<string>((Array.isArray(manifest.suitable_models) ? manifest.suitable_models : []).map((item: unknown) => String(item).trim()).filter((item: string) => Boolean(item)))].slice(0, 64),
    compose: validateCompose(String(document.compose ?? "")),
    files
  };
}
