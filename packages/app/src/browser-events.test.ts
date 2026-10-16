import { afterEach, expect, it, vi } from "vitest";
import { watchBrowserEvents } from "./browser-events";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reconnects a dropped stream but never reconnects or delivers events after unsubscribe", () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    close = vi.fn(() => this.onclose?.());
    constructor(public url: URL) {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const onEvent = vi.fn();
  const stop = watchBrowserEvents(
    "/api/open-requests?path=a.md",
    "open-request",
    onEvent,
  );
  expect(sockets[0].url.protocol).toBe("ws:");
  expect(sockets[0].url.searchParams.get("path")).toBe("a.md");
  sockets[0].onclose?.();
  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  const event = {
    data: JSON.stringify({ event: "open-request", data: "payload" }),
  };
  sockets[1].onmessage?.(event);
  expect(onEvent).toHaveBeenCalledExactlyOnceWith("payload");
  sockets[1].onclose?.();
  stop();
  sockets[1].onmessage?.(event);
  vi.advanceTimersByTime(5000);
  expect(sockets).toHaveLength(2);
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(sockets[1].close).toHaveBeenCalledOnce();
});
