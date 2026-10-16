import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { expect, test } from "@playwright/test";
import { createApp } from "../../server/src/index";
import {
  appendInCodeEditor,
  codeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("multi-tab review handoff", () => {
  let projectDir: string;
  let server: Server;
  let appUrl: string;
  let eventConnections: Set<Duplex>;

  test.beforeEach(async () => {
    projectDir = createMarkdownProject("multi-tab-handoff");
    server = createApp().createHttpServer();
    eventConnections = new Set();
    server.on("upgrade", (_req, socket) => {
      eventConnections.add(socket);
      socket.on("close", () => eventConnections.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the isolated HTTP server to have a TCP port");
    }
    appUrl = `http://127.0.0.1:${address.port}`;
  });

  test.afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    removeMarkdownProject(projectDir);
  });

  test("completes the correct review while seven document tabs keep their event streams open", async ({
    browser,
    request,
  }) => {
    test.setTimeout(40_000);
    const context = await browser.newContext({ baseURL: appUrl });
    const documents = Array.from({ length: 7 }, (_, index) => {
      const relativePath = `document-${index + 1}.md`;
      return {
        relativePath,
        absolutePath: writeProjectFile(
          projectDir,
          relativePath,
          `# Document ${index + 1}\n\nIndependent review ${index + 1}.\n`,
        ),
      };
    });
    const target = documents[6];
    if (!target) throw new Error("Expected a seventh document fixture");

    const watchResponse = request.post(`${appUrl}/api/review-events/watch`, {
      data: {
        projectPath: projectDir,
        path: target.relativePath,
        timeoutSeconds: 25,
      },
    });

    try {
      const pages = [];
      for (const [index, document] of documents.entries()) {
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(3_000);
        pages.push(page);
        await openMarkdownFile(page, document.absolutePath, "code");
        await expect(
          codeEditor(page),
          `tab ${index + 1} should load without waiting for an HTTP/1 connection`,
        ).toBeVisible({ timeout: 3_000 });
        logE2eEvent("multi-tab-handoff.tab-loaded", {
          tab: index + 1,
          document: document.relativePath,
        });
      }

      const targetPage = pages[6];
      if (!targetPage) throw new Error("Expected the seventh browser tab");
      const edit = "\nSaved from the seventh tab.\n";
      await appendInCodeEditor(targetPage, edit);
      // Isolate connection starvation from concurrent autosave/handoff writes.
      await expect(
        targetPage.getByTestId("document-save-status"),
      ).toHaveAttribute("aria-label", "Saved");
      const overallComment = "Seven open tabs must not block this handoff.";
      await targetPage.getByTestId("review-handoff-comment-trigger").click();
      await targetPage
        .getByTestId("review-handoff-overall-comment")
        .fill(overallComment);
      await targetPage.getByTestId("review-handoff-button").click();

      await expect(
        targetPage.getByTestId("review-handoff-status"),
      ).toContainText("Your agent is now working", { timeout: 5_000 });
      await expect
        .poll(() => readProjectFile(projectDir, target.relativePath), {
          timeout: 5_000,
        })
        .toContain(overallComment);
      expect(readProjectFile(projectDir, target.relativePath)).toContain(edit);
      for (const document of documents.slice(0, 6)) {
        expect(
          readProjectFile(projectDir, document.relativePath),
        ).not.toContain(overallComment);
      }

      const payload = await (await watchResponse).json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        type: "review.completed",
        relativePath: target.relativePath,
        overallComment,
      });
      logE2eEvent("multi-tab-handoff.review-completed", {
        openTabs: pages.length,
        document: target.relativePath,
      });

      // Disabling notifications altogether would also free HTTP slots. Prove
      // that every tab still follows disk changes, including after a disconnect.
      for (const socket of eventConnections) socket.destroy();
      for (const [index, document] of documents.entries()) {
        writeProjectFile(
          projectDir,
          document.relativePath,
          `# Reconnected document ${index + 1}\n`,
        );
      }
      for (const [index, page] of pages.entries()) {
        await expect(codeEditor(page)).toContainText(
          `Reconnected document ${index + 1}`,
        );
      }
      logE2eEvent("multi-tab-handoff.reconnected", { openTabs: pages.length });

      // CLI open-request reuse must still target only the matching tab.
      const first = documents[0];
      const firstPage = pages[0];
      if (!first || !firstPage) throw new Error("Expected the first tab");
      const reopenedUrl = new URL(firstPage.url());
      reopenedUrl.searchParams.set("reopened", "1");
      await expect
        .poll(async () => {
          const response = await request.post(`${appUrl}/api/open-request`, {
            data: { path: first.absolutePath, url: reopenedUrl.href },
          });
          return (await response.json()).delivered;
        })
        .toBe(true);
      await expect(firstPage).toHaveURL(reopenedUrl.href);
      expect(targetPage.url()).not.toContain("reopened");
    } finally {
      await context.close();
      await watchResponse.catch(() => undefined);
    }
  });
});
