import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./index";

describe("browser event upgrades", () => {
  let server: Server;
  let origin: string;
  let projectDir: string;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-ws-"));
    fs.writeFileSync(path.join(projectDir, " draft.md"), "# Original\n");
    server = createApp().createHttpServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function connect(route: string, browserOrigin?: string): WebSocket {
    const client = new WebSocket(origin.replace("http:", "ws:") + route, {
      origin: browserOrigin,
    });
    clients.push(client);
    return client;
  }

  it.each([
    undefined,
    "null",
    "https://untrusted.example",
  ])("rejects an upgrade with origin %s", async (browserOrigin) => {
    const client = connect("/api/open-requests", browserOrigin);
    const [error] = await once(client, "error");
    expect(error.message).toContain("403");
  });

  it.each([
    "../outside.md",
    "missing.md",
    "secret.txt",
  ])("rejects invalid file subscription %s", async (filePath) => {
    const query = new URLSearchParams({
      projectPath: projectDir,
      path: filePath,
    });
    const client = connect(`/api/markdown-file/events?${query}`, origin);
    const [error] = await once(client, "error");
    expect(error.message).toContain("404");
  });

  it("reconciles file versions on connect and reports deletion without trimming the filename", async () => {
    const filePath = " draft.md";
    const query = new URLSearchParams({
      projectPath: projectDir,
      path: filePath,
    });
    const client = connect(`/api/markdown-file/events?${query}`, origin);
    const [initial] = await once(client, "message");
    const initialEvent = JSON.parse(initial.toString());
    expect(initialEvent.event).toBe("change");
    expect(JSON.parse(initialEvent.data)).toMatchObject({
      path: filePath,
      exists: true,
      version: expect.any(String),
    });

    const deleted = once(client, "message");
    fs.unlinkSync(path.join(projectDir, filePath));
    const [message] = await deleted;
    expect(JSON.parse(JSON.parse(message.toString()).data)).toEqual({
      path: filePath,
      exists: false,
      version: null,
    });
  });
});
