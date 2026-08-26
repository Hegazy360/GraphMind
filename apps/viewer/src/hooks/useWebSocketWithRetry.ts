/**
 * Near-verbatim TypeScript port of the legacy GraphMind
 * `useWebSocketWithRetry` hook (client/src/hooks/useWebSocketWithRetry.jsx):
 * exponential backoff, stale-connection guards, URL-change safety.
 */
import { useEffect, useRef, useState } from 'react';

export interface UseWebSocketWithRetryOptions {
  retryInterval?: number;
  maxRetries?: number;
  /** Called on state transitions so the UI can show a connection dot. */
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
}

const useWebSocketWithRetry = (
  url: string | null,
  { retryInterval = 1000, maxRetries = 10, onStatus }: UseWebSocketWithRetryOptions = {},
): WebSocket | null => {
  const [webSocket, setWebSocket] = useState<WebSocket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const shouldReconnectRef = useRef(true);
  const currentUrlRef = useRef(url);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeConnectionIdRef = useRef(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!url) {
      setWebSocket(null);
      return;
    }

    // Update the current URL ref when the URL changes
    currentUrlRef.current = url;
    // Reset reconnection flag when URL changes
    shouldReconnectRef.current = true;

    let retries = 0;
    let ws: WebSocket;

    const connect = () => {
      // Don't attempt to connect if we shouldn't reconnect
      if (!shouldReconnectRef.current) {
        return;
      }

      // If we already have an open connection to the same URL, reuse it
      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        currentUrlRef.current === url
      ) {
        // Ensure state is set
        setWebSocket(wsRef.current);
        return;
      }

      // If a previous reconnect timeout exists, clear it
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Connect using the provided URL (may already include auth params)
      const connectionUrl = currentUrlRef.current;
      if (connectionUrl === null) return;
      onStatusRef.current?.('connecting');
      ws = new WebSocket(connectionUrl);
      wsRef.current = ws;
      const connectionId = ++activeConnectionIdRef.current;

      ws.onopen = () => {
        setWebSocket(ws);
        onStatusRef.current?.('open');
        retries = 0; // Reset retry counter upon successful connection
      };

      ws.onclose = () => {
        // Ignore close events from stale connections
        if (connectionId !== activeConnectionIdRef.current) {
          return;
        }
        setWebSocket(null);
        onStatusRef.current?.('closed');
        // Only attempt to reconnect if the URL hasn't changed and we haven't reached max retries
        if (
          shouldReconnectRef.current &&
          url === currentUrlRef.current &&
          retries < maxRetries
        ) {
          // Exponential backoff
          reconnectTimeoutRef.current = setTimeout(
            () => {
              retries++;
              connect(); // Attempt to reconnect
            },
            retryInterval * Math.pow(2, retries),
          );
        }
      };

      // Handle errors (the close handler owns the retry)
      ws.onerror = () => {};
    };

    connect();

    // Cleanup function to close the WebSocket connection when the component unmounts or URL changes
    return () => {
      shouldReconnectRef.current = false; // Prevent reconnection attempts
      // Prevent stale onclose handlers from scheduling reconnects
      if (wsRef.current) {
        wsRef.current.onclose = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [url, maxRetries, retryInterval]);

  return webSocket;
};

export default useWebSocketWithRetry;
