import type { ContainerManagementMode, ContainerRestartPolicy, ContainerSettings } from "./types.js";

/* ── types ────────────────────────────────────── */
export interface ContainerRecord {
  key: string;
  name: string;
  slot_name: string;
  instance_name: string | null;
  title: string;
  image: string;
  status: string;
  state: "running" | "stopped" | "missing" | "unknown";
  ports: string;
  public_port: number;
  runtime: string;
  management_mode: ContainerManagementMode;
  restart_policy: ContainerRestartPolicy;
  auto_restart: boolean;
  preset: boolean;
  components: string[];
  official_image: string;
  image_pulled: boolean;
  test_status: "untested" | "running" | "passed" | "failed";
  software_versions: Record<string, string>;
}

export interface CustomContainerRequest {
  name?: string;
  image?: string;
  components?: string[];
  compose_yaml?: string;
  management_mode?: ContainerManagementMode;
  restart_policy?: ContainerRestartPolicy;
  auto_restart?: boolean;
}

/* ── constants ─────────────────────────────────── */
export const hiddenContainerNames = new Set(["api", "frontend", "postgres", "milvus-standalone", "milvus-etcd", "milvus-minio"]);
export const modelRuntimePrefixes = ["vllm_", "trtllm_", "pytorch_", "custom_"];

/* ── presets ──────────────────────────────────── */
export type RuntimePreset = {
  key: string;
  title: string;
  runtime: string;
  names: string[];
  prefix: string;
  port: number;
  image: string;
  components: string[];
  versions: Record<string, string>;
  management_mode: "resident" | "once";
};

export const presets: RuntimePreset[] = [
  {
    key: "vllm", title: "vLLM", runtime: "vllm",
    names: ["vllm-service"], prefix: "vllm_", port: 30000,
    image: process.env.VLLM_IMAGE ?? "vllm/vllm-openai:latest",
    components: ["python", "cuda", "pytorch", "vllm"],
    versions: { "vLLM": "vllm/vllm-openai:latest", Python: "3.x (container)", CUDA: "NVIDIA runtime" },
    management_mode: "resident" as const
  },
  {
    key: "trtllm", title: "TensorRT-LLM", runtime: "trtllm",
    names: ["trtllm-service"], prefix: "trtllm_", port: 31000,
    image: process.env.TRTLLM_IMAGE ?? "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6",
    components: ["cuda", "tensorrt-llm"],
    versions: { "TensorRT-LLM": "v1.2.0-rc6", "NVIDIA Image": "nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6" },
    management_mode: "resident" as const
  },
  {
    key: "pytorch", title: "PyTorch", runtime: "pytorch",
    names: ["pytorch-service"], prefix: "pytorch_", port: 32000,
    image: process.env.PYTORCH_IMAGE ?? "nvcr.io/nvidia/pytorch:25.04-py3",
    components: ["python", "pytorch", "cuda"],
    versions: { "PyTorch": "2.x (NVIDIA 25.04)", "Python": "3.x (container)", "CUDA": "NVIDIA runtime" },
    management_mode: "resident" as const
  }
];

/* ── preset helpers ────────────────────────────── */
export function presetForKey(key: string): RuntimePreset | undefined {
  return presets.find((preset) => preset.key === key);
}

export function defaultSettingsFor(key: string, publicPort: number, managementMode: ContainerManagementMode): ContainerSettings {
  const lazyRuntime = key === "vllm" || key === "trtllm";
  const preset = presetForKey(key);
  return {
    key, public_port: publicPort, management_mode: managementMode,
    restart_policy: lazyRuntime ? "no" : "unless-stopped",
    auto_restart: !lazyRuntime,
    image: preset?.image,
    updated_at: new Date().toISOString()
  };
}

/* ── name filtering ───────────────────────────── */
export function isModelPublishingContainer(name: string): boolean {
  if (hiddenContainerNames.has(name)) return false;
  return modelRuntimePrefixes.some((prefix) => name.startsWith(prefix));
}
