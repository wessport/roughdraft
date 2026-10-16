// WebSockets do not hold HTTP/1 connection-pool slots like EventSource does.
// Keep local file/open notifications off that pool so other tabs can still save.
export function watchBrowserEvents(
  route: string,
  eventName: string,
  onEvent: (data: string) => void,
): () => void {
  const url = new URL(route, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket;

  const connect = () => {
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      if (stopped) return;
      try {
        const message = JSON.parse(event.data) as {
          event: string;
          data: string;
        };
        if (message.event === eventName) onEvent(message.data);
      } catch (error) {
        console.error("Failed to read browser event:", error);
      }
    };
    socket.onclose = () => {
      if (!stopped) retry = setTimeout(connect, 1000);
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket.close();
  };
}
