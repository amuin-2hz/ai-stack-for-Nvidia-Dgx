import { readBody, sendJson } from "../serverUtils.js";
import { getContainerConfig } from "../store.js";

export function register(
  route: (method: string, path: string, handler: (...args: any[]) => Promise<void>) => void,
  dh: any,
  oai: any
) {
  route("GET", "/v1/models", async (_req: any, res: any) => {
    const deployments = await dh.liveActiveDeployments();
    const data: Array<{ id: string; object: string; owned_by: string }> = deployments
      .filter((d: any) => d.status === "running")
      .map((d: any) => ({ id: d.openai_model, object: "model", owned_by: d.service_type }));

    const pytorchConfig = getContainerConfig("pytorch");
    if (pytorchConfig) {
      data.push({ id: "whisper-tiny", object: "model", owned_by: "pytorch" });
    }

    sendJson(res, 200, { object: "list", data });
  });

  route("POST", "/v1/chat/completions", async (req: any, res: any) => {
    await oai.proxyOpenAiRequest(res, await readBody(req), "/chat/completions");
  });

  route("POST", "/v1/embeddings", async (req: any, res: any) => {
    await oai.proxyOpenAiRequest(res, await readBody(req), "/embeddings");
  });
}
