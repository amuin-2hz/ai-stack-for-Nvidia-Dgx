import { readBody, sendJson } from "../serverUtils.js";
import {
  deploymentApiKind,
  deploymentEndpointPath,
  directDeploymentUrl
} from "../deploymentEndpoints.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  dh: any,
  oai: any
) {
  route("GET", "/v1/models", async (req: any, res: any) => {
    const deployments = await dh.liveActiveDeployments();
    const data = deployments
      .filter((d: any) => d.status === "running")
      .map((d: any) => ({
        id: d.openai_model,
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
        }
      }));

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
}
