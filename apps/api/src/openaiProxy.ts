import type { ServerResponse } from "node:http";
import { proxyHttp } from "./httpProxy.js";
import { createDeploymentHelpers } from "./deploymentHelpers.js";
import { compatibilityFor, getModel } from "./modelRegistry.js";
import { startDeployment } from "./deploymentManager.js";
import type { StateStore } from "./state.js";
import type { ServiceType } from "./types.js";

export interface OpenAIProxyDeps {
  store: StateStore;
  modelsRoot: string;
  workspaceRoot: string;
  logsRoot: string;
  deploymentHelpers: ReturnType<typeof createDeploymentHelpers>;
}

export function createOpenAiProxy(deps: OpenAIProxyDeps) {
  const { store, modelsRoot, workspaceRoot, logsRoot, deploymentHelpers } =
    deps;
  const {
    liveActiveDeployments,
    configuredDeployments,
    runtimeOpenAiBaseUrl,
    runtimeHealthUrl
  } = deploymentHelpers;

  async function proxyOpenAiRequest(
    res: ServerResponse,
    body: Record<string, unknown>,
    path: string
  ): Promise<void> {
    const modelId = String(body.model ?? "");
    if (!modelId) {
      sendJsonProxy(res, 400, { error: { message: "model is required" } });
      return;
    }
    let deployments = await liveActiveDeployments();
    let deployment = deployments.find(
      (item) =>
        item.openai_model === modelId || item.model_id === modelId
    );
    if (!deployment) {
      const autoloaded = await autoLoadDeploymentForModel(modelId);
      if (autoloaded) {
        deployments = await liveActiveDeployments();
        deployment = deployments.find(
          (item) =>
            item.openai_model === modelId || item.model_id === modelId
        );
      }
    }
    if (!deployment) {
      sendJsonProxy(res, 404, {
        error: {
          message:
            "Model " +
            modelId +
            " is not registered on a running OpenAI-compatible runtime.",
          available_models: deployments.map((item) => item.openai_model)
        }
      });
      return;
    }
    const baseUrl =
      deployment.worker_endpoint ??
      runtimeOpenAiBaseUrl(deployment.service_type);
    if (!baseUrl) {
      sendJsonProxy(res, 409, {
        error: {
          message:
            "Service " +
            deployment.service_type +
            " does not expose " +
            path +
            "."
        }
      });
      return;
    }
    const result = await proxyHttp(
      "POST",
      baseUrl + path,
      JSON.stringify(body),
      { "content-type": "application/json" }
    );
    res.writeHead(result.status, {
      "content-type":
        result.contentType || "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    });
    res.end(result.body);
  }

  async function autoLoadDeploymentForModel(modelId: string) {
    const model = await getModel(modelsRoot, modelId);
    if (!model) return null;
    const serviceType: ServiceType | null =
      compatibilityFor(model, "vllm").status === "compatible"
        ? "vllm"
        : compatibilityFor(model, "trtllm").status === "compatible"
          ? "trtllm"
          : null;
    if (!serviceType) return null;
    const deployment = (await configuredDeployments()).find(
      (item) => item.service_type === serviceType
    );
    if (!deployment) return null;
    const containerSettings = await store.getContainerSettings(serviceType);
    await startDeployment(
      store,
      deployment,
      model,
      { service_type: serviceType, openai_model: modelId, args: {} },
      workspaceRoot,
      logsRoot,
      containerSettings
    );
    return waitForDeploymentReady(modelId, serviceType);
  }

  async function waitForDeploymentReady(
    modelId: string,
    serviceType: ServiceType
  ) {
    const deadline =
      Date.now() +
      Number(process.env.AI_STACK_LAZY_LOAD_TIMEOUT_MS ?? 900000);
    while (Date.now() < deadline) {
      const deployments = await liveActiveDeployments();
      const deployment = deployments.find(
        (item) =>
          item.service_type === serviceType &&
          (item.openai_model === modelId || item.model_id === modelId)
      );
      if (deployment) {
        const healthTarget =
          deployment.health_url ?? runtimeHealthUrl(deployment.service_type);
        const health = await proxyHttp("GET", healthTarget);
        if (health.ok) return deployment;
      }
      await sleep(3000);
    }
    return null;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    proxyOpenAiRequest,
    autoLoadDeploymentForModel,
    waitForDeploymentReady
  };
}

function sendJsonProxy(
  res: ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}
