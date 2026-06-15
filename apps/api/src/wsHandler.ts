import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import type { StateStore } from "./state.js";

function getPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

export function createWsHandler(deps: {
  store: StateStore;
  wss: WebSocketServer;
  audioServiceWsUrl: string;
  proxyWebSocket: (
    req: IncomingMessage,
    socket: any,
    head: Buffer,
    target: string,
    wss: WebSocketServer
  ) => void;
}) {
  const { store, wss, audioServiceWsUrl, proxyWebSocket } = deps;

  function handleUpgrade(
    req: IncomingMessage,
    socket: any,
    head: Buffer
  ): void {
    const path = getPath(req);
    if (path.startsWith("/ws/audio/")) {
      proxyWebSocket(req, socket, head, audioServiceWsUrl, wss);
      return;
    }
    if (!path.startsWith("/ws/chat/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }

  function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    void (async () => {
      const chatId = decodeURIComponent(
        getPath(req).split("/").pop() || (await store.getCurrentChatId())
      );
      const chat = await store.getChat(chatId);
      ws.send(JSON.stringify({ type: "history", messages: chat.messages }));
      ws.on("message", async (data) => {
        try {
          const payload = JSON.parse(data.toString()) as {
            message?: string;
          };
          const text = payload.message?.trim();
          if (!text) return;
          await store.appendMessage(chatId, {
            type: "HumanMessage",
            content: text
          });
          ws.send(
            JSON.stringify({ type: "node_start", data: "generate" })
          );
          const answer = await makeAssistantReply(text);
          for (const token of chunkText(answer)) {
            ws.send(JSON.stringify({ type: "token", token }));
            await new Promise((resolve) => setTimeout(resolve, 8));
          }
          await store.appendMessage(chatId, {
            type: "AssistantMessage",
            content: answer
          });
          ws.send(
            JSON.stringify({ type: "node_end", data: "generate" })
          );
          const updated = await store.getChat(chatId);
          ws.send(
            JSON.stringify({
              type: "history",
              messages: updated.messages
            })
          );
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "error",
              content:
                error instanceof Error ? error.message : String(error)
            })
          );
        }
      });
    })();
  }

  async function makeAssistantReply(text: string): Promise<string> {
    const model = await store.selectedModel();
    return [
      `Node/TypeScript control plane is online.`,
      ``,
      `Selected model: ${model || "not selected"}.`,
      `Your message: ${text}`,
      ``,
      `Runtime inference is not connected yet; this compatibility reply confirms the WebSocket chat path has moved off Python.`
    ].join("\n");
  }

  function chunkText(text: string): string[] {
    return text.match(/.{1,18}(\s|$)/g) ?? [text];
  }

  return { handleUpgrade, handleConnection };
}
