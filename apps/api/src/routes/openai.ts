import { readBody, sendJson } from "../serverUtils.js";
import {
  deploymentApiKind,
  deploymentEndpointPath,
  directDeploymentUrl
} from "../deploymentEndpoints.js";
import { proxyAudioMultipart } from "../audioProxy.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  dh: any,
  oai: any
) {
  route("GET", "/v1/models", async (req: any, res: any) => {
    const deployments = await dh.liveActiveDeployments();
    const data = deployments
      .filter((d: any) => d.status === "running")
      .flatMap((d: any) => {
        const apiModels = Array.isArray(d.suite?.api_models) && d.suite.api_models.length
          ? d.suite.api_models
          : [d.openai_model];
        return apiModels.map((apiModel: string) => ({
          id: apiModel,
          object: "model",
          owned_by: d.service_type,
          endpoint: directDeploymentUrl(req, d),
          method: "POST",
          api_kind: deploymentApiKind(d),
          path: deploymentEndpointPath(d),
          routing: {
            deployment_id: d.deployment_id,
            runtime: d.runtime,
            public_port: d.public_port
          },
          ...(d.suite ? {
            service: d.runtime,
            suite: d.suite.title ?? d.runtime,
            components: d.suite.components
          } : {})
        }));
      });

    sendJson(res, 200, { object: "list", data });
  });

  route("POST", "/v1/chat/completions", async (req: any, res: any) => {
    await oai.proxyOpenAiRequest(res, await readBody(req), "/chat/completions");
  });

  route("POST", "/v1/embeddings", async (req: any, res: any) => {
    await oai.proxyOpenAiRequest(res, await readBody(req), "/embeddings");
  });

  route("POST", "/v1/score", async (req: any, res: any) => {
    await oai.proxyOpenAiRequest(res, await readBody(req), "/score");
  });

  route("POST", "/v1/audio/transcriptions", async (req: any, res: any) => {
    const audioServiceUrl = process.env.AUDIO_SERVICE_URL ?? "http://127.0.0.1:8011";
    await proxyAudioMultipart(req, res, audioServiceUrl, "/v1/audio/transcriptions");
  });
}
