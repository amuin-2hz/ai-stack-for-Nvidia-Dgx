import type { ActiveDeploymentRecord } from "./types.js";
import { listDeployments } from "./modelRegistry.js";
import { listContainers } from "./containerManager.js";
import {
  listContainerConfigs,
  listActiveDeployments,
  getActiveDeployment,
  deleteDeployment,
} from "./store.js";

export interface DeploymentHelpersDeps {
  modelsRoot: string;
  audioServiceUrl: string;
}

export type ConfiguredDeployment = Awaited<
  ReturnType<typeof listDeployments>
>[number] & {
  public_port: number;
  base_url: string;
  health_url: string;
};

export function createDeploymentHelpers(deps: DeploymentHelpersDeps) {
  const { modelsRoot, audioServiceUrl } = deps;

  async function configuredDeployments(): Promise<ConfiguredDeployment[]> {
    const configs = listContainerConfigs();
    return (await listDeployments(modelsRoot)).map((deployment) => {
      const config = configs.find((c: any) => c.key === deployment.service_type);
      if (!config) return deployment as ConfiguredDeployment;
      const suffix = ["vllm", "trtllm"].includes(deployment.service_type)
        ? "/v1"
        : "";
      const healthSuffix =
        deployment.service_type === "audio" ? "/healthz" : "/health";
      return {
        ...deployment,
        public_port: config.public_port,
        base_url: "http://localhost:" + config.public_port + suffix,
        health_url: "http://localhost:" + config.public_port + healthSuffix
      };
    });
  }

  function normalizeDeployment<
    T extends {
      service_type: string;
      container_name?: string | null;
      worker_endpoint?: string | null;
      public_port?: number;
    }
  >(deployment: T): T {
    if (deployment.service_type === "vllm") {
      return {
        ...deployment,
        container_name: deployment.container_name || "vllm-service",
        worker_endpoint:
          "http://127.0.0.1:" + (deployment.public_port ?? 30000) + "/v1"
      };
    }
    if (deployment.service_type === "trtllm") {
      return {
        ...deployment,
        container_name: deployment.container_name || "trtllm-service",
        worker_endpoint:
          "http://127.0.0.1:" + (deployment.public_port ?? 31000) + "/v1"
      };
    }
    return deployment;
  }

  async function deploymentContainerIsRunning(
    containerName: string | null | undefined
  ): Promise<boolean> {
    if (!containerName) return false;
    const payload = await listContainers();
    return payload.containers.some(
      (container) =>
        (container.name === containerName ||
          container.instance_name === containerName) &&
        container.state === "running"
    );
  }

  async function liveActiveDeployments(): Promise<ActiveDeploymentRecord[]> {
    const active = listActiveDeployments();
    const live: ActiveDeploymentRecord[] = [];
    for (const deployment of active) {
      const normalized = normalizeDeployment(deployment);
      if (await deploymentContainerIsRunning(normalized.container_name)) {
        live.push(normalized);
      } else {
        deleteDeployment(normalized.deployment_id);
      }
    }
    return live;
  }

  function mergeDeployments(
    configured: Awaited<ReturnType<typeof listDeployments>>,
    active: ReturnType<typeof listActiveDeployments>
  ) {
    const byId = new Map(
      configured.map((deployment) => [deployment.deployment_id, deployment])
    );
    for (const deployment of active) {
      const normalized = normalizeDeployment(deployment);
      byId.set(normalized.deployment_id, {
        deployment_id: normalized.deployment_id,
        model_id: normalized.model_id,
        status: normalized.status,
        service_type: normalized.service_type,
        runtime: normalized.runtime,
        container_name: normalized.container_name,
        public_port: normalized.public_port,
        base_url: normalized.base_url,
        health_url: normalized.health_url,
        worker_endpoint: normalized.worker_endpoint,
        openai_models: [normalized.openai_model],
        warnings: [] as string[]
      });
    }
    return [...byId.values()];
  }

  async function findDeployment(deploymentId: string) {
    const active = getActiveDeployment(deploymentId);
    if (active) {
      const normalized = normalizeDeployment(active);
      if (await deploymentContainerIsRunning(normalized.container_name))
        return normalized;
      deleteDeployment(normalized.deployment_id);
    }
    const deployment = (await configuredDeployments()).find(
      (item) => item.deployment_id === deploymentId
    );
    return deployment ? normalizeDeployment(deployment) : deployment;
  }

  function runtimeHealthUrl(serviceType: string): string {
    if (serviceType === "audio") return audioServiceUrl + "/healthz";
    if (serviceType === "vllm")
      return (
        process.env.VLLM_INTERNAL_HEALTH_URL ??
        "http://vllm-service:8000/health"
      );
    if (serviceType === "trtllm")
      return (
        process.env.TRTLLM_INTERNAL_HEALTH_URL ??
        "http://trtllm-service:8000/health"
      );
    return "http://127.0.0.1/health";
  }

  function runtimeOpenAiBaseUrl(serviceType: string): string | null {
    if (serviceType === "vllm")
      return (
        process.env.VLLM_INTERNAL_BASE_URL ??
        "http://127.0.0.1:30000/v1"
      );
    if (serviceType === "trtllm")
      return (
        process.env.TRTLLM_INTERNAL_BASE_URL ??
        "http://127.0.0.1:31000/v1"
      );
    return null;
  }

  return {
    configuredDeployments,
    findDeployment,
    liveActiveDeployments,
    normalizeDeployment,
    mergeDeployments,
    deploymentContainerIsRunning,
    runtimeHealthUrl,
    runtimeOpenAiBaseUrl
  };
}
