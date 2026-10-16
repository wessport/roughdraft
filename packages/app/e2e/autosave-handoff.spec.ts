import type { APIResponse } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  appendInCodeEditor,
  createMarkdownProject,
  logE2eEvent,
  openMarkdownFile,
  readProjectFile,
  removeMarkdownProject,
  writeProjectFile,
} from "./helpers";

test.describe("autosave review handoff", () => {
  let projectDir: string;
  let pendingWatch: Promise<APIResponse> | null = null;

  test.beforeEach(() => {
    projectDir = createMarkdownProject("autosave-handoff");
    pendingWatch = null;
  });

  test.afterEach(async () => {
    await pendingWatch?.catch(() => undefined);
    removeMarkdownProject(projectDir);
  });

  for (const fileEvents of ["connected", "disconnected"]) {
    test(`waits for in-flight autosave and retains newer edits (${fileEvents})`, async ({
      page,
      request,
    }) => {
      const relativePath = "autosave-handoff.md";
      const filePath = writeProjectFile(
        projectDir,
        relativePath,
        "# Autosave handoff\n\nOriginal review text.\n",
      );
      const firstEdit = "\nFirst edit starts autosave.\n";
      const newerEdit = "\nNewer edit while autosave is in flight.\n";
      const putStatuses: number[] = [];
      const watchedVersions: string[] = [];
      let savedVersion: string;
      page.on("websocket", (socket) => {
        if (!socket.url().includes("/api/markdown-file/events")) return;
        socket.on("framereceived", ({ payload }) => {
          const message = JSON.parse(payload.toString());
          if (message.event === "change") {
            watchedVersions.push(JSON.parse(message.data).version);
          }
        });
      });
      let releaseFirstPut!: () => void;
      const releaseFirstPutResponse = new Promise<void>((resolve) => {
        releaseFirstPut = resolve;
      });
      let markFirstPutCommitted!: () => void;
      const firstPutCommitted = new Promise<void>((resolve) => {
        markFirstPutCommitted = resolve;
      });
      let interceptedFirstPut = false;

      if (fileEvents === "disconnected") {
        await page.routeWebSocket("**/api/markdown-file/events**", (route) =>
          route.close(),
        );
      }
      await page.route("**/api/markdown-file?**", async (route) => {
        if (route.request().method() !== "PUT" || interceptedFirstPut) {
          await route.continue();
          return;
        }

        interceptedFirstPut = true;
        // Commit the autosave at the real API boundary, but keep the browser from
        // learning its new version until Send Feedback has joined the in-flight save.
        const response = await route.fetch();
        savedVersion = (await response.json()).version;
        logE2eEvent("autosave-handoff.put-committed-response-held", {
          status: response.status(),
        });
        markFirstPutCommitted();
        await releaseFirstPutResponse;
        await route.fulfill({ response });
      });

      page.on("response", (response) => {
        if (
          response.request().method() === "PUT" &&
          response.url().includes("/api/markdown-file")
        ) {
          putStatuses.push(response.status());
          logE2eEvent("autosave-handoff.put-response", {
            status: response.status(),
          });
        }
      });

      pendingWatch = request.post("/api/review-events/watch", {
        data: {
          projectPath: projectDir,
          path: relativePath,
          timeoutSeconds: 10,
        },
      });

      await openMarkdownFile(page, filePath, "code");
      await appendInCodeEditor(page, firstEdit);
      await firstPutCommitted;
      expect(readProjectFile(projectDir, relativePath)).toContain(firstEdit);

      await appendInCodeEditor(page, newerEdit);
      if (fileEvents === "connected") {
        // Force the filesystem event to arrive before the HTTP response.
        await expect.poll(() => watchedVersions).toContain(savedVersion);
      }
      await page.getByTestId("review-handoff-button").click();
      releaseFirstPut();

      await expect(page.getByTestId("review-handoff-status")).toContainText(
        "Your agent is now working",
      );
      await expect
        .poll(() => readProjectFile(projectDir, relativePath))
        .toContain(newerEdit);

      const watchResponse = await pendingWatch;
      const payload = await watchResponse.json();
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0]).toMatchObject({
        type: "review.completed",
        relativePath,
      });
      expect(putStatuses).toEqual([200, 200]);
      expect(readProjectFile(projectDir, relativePath)).toContain(firstEdit);
      expect(readProjectFile(projectDir, relativePath)).toContain(newerEdit);

      logE2eEvent("autosave-handoff.completed", {
        putStatuses,
        eventDelivered: true,
      });
    });
  }

  test("immediate feedback flushes the debounce before persisting the overall comment @smoke", async ({
    page,
    request,
  }) => {
    const relativePath = "immediate.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      "# Immediate\n\nReview text.\n",
    );
    const overallComment = "Keep the new details in the next revision.";
    const operations: string[] = [];
    await page.route("**/api/**", async (route) => {
      const method = route.request().method();
      if (method === "PUT" || method === "POST")
        operations.push(`${method} ${new URL(route.request().url()).pathname}`);
      await route.continue();
    });
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 10 },
    });
    await openMarkdownFile(page, filePath, "code");
    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill(overallComment);
    await page.keyboard.press("Escape");
    await appendInCodeEditor(page, "\nNew details.\n");
    await page.getByTestId("review-handoff-button").click();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Your agent is now working",
    );
    const payload = await (await pendingWatch).json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      type: "review.completed",
      overallComment,
    });
    // Let any stale debounce fire: it must not rewrite the comment endmatter.
    await page.waitForTimeout(1000);
    expect(operations).toEqual([
      "PUT /api/markdown-file",
      "POST /api/review-events",
    ]);
    const saved = readProjectFile(projectDir, relativePath);
    expect(saved).toContain("New details.");
    expect(saved).toContain(`body: ${overallComment}`);
    logE2eEvent("autosave-handoff.immediate-completed", { operations });
  });

  test("a conflicting flush does not overwrite disk or notify the agent", async ({
    page,
    request,
  }) => {
    const relativePath = "external-conflict.md";
    const filePath = writeProjectFile(
      projectDir,
      relativePath,
      "# Conflict\n\nOriginal.\n",
    );
    await page.routeWebSocket("**/api/markdown-file/events**", (route) =>
      route.close(),
    );
    let releasePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    await page.route("**/api/markdown-file?**", async (route) => {
      if (route.request().method() === "PUT") await putReleased;
      await route.continue();
    });
    pendingWatch = request.post("/api/review-events/watch", {
      data: { projectPath: projectDir, path: relativePath, timeoutSeconds: 10 },
    });
    let handoffs = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/review-events"
      )
        handoffs++;
    });
    await openMarkdownFile(page, filePath, "code");
    await expect(page.getByTestId("markdown-code-editor")).toContainText(
      "Original.",
    );
    await expect(page.getByTestId("review-handoff-button")).toBeVisible();
    const external = "# Conflict\n\nExternal edit must survive.\n";
    writeProjectFile(projectDir, relativePath, external);
    await appendInCodeEditor(page, "\nLocal draft.\n");
    await page.getByTestId("review-handoff-button").click();
    releasePut();
    await expect(page.getByTestId("review-handoff-status")).toContainText(
      "Could not notify agent",
    );
    expect(readProjectFile(projectDir, relativePath)).toBe(external);
    expect(handoffs).toBe(0);
    await expect(page.getByTestId("markdown-code-editor")).toContainText(
      "Local draft.",
    );
    expect((await (await pendingWatch).json()).events).toEqual([]);
  });
});
