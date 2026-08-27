/**
 * A WebSocket implementation the harness can grab hold of.
 *
 * `SessionOptions.webSocket` is the documented injection point. Wrapping the
 * `ws` package here gives the reconnect scenarios a handle on the live socket
 * (so they can drop it the way a crashed viewer or a network blip would) and
 * exposes `bufferedAmount`, which is how far behind the send queue is running.
 *
 * Scenarios that are not about disconnection deliberately use the default
 * platform WebSocket instead — that is what a real instrumented app gets.
 */
import { WebSocket as WsWebSocket } from 'ws';
import type { WebSocketLike } from '@graphmind-ai/client';

export class TrackedWebSocket implements WebSocketLike {
  /** Every socket this constructor has ever produced, oldest first. */
  static readonly instances: TrackedWebSocket[] = [];

  readonly raw: WsWebSocket;

  constructor(url: string) {
    this.raw = new WsWebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    TrackedWebSocket.instances.push(this);
  }

  static reset(): void {
    TrackedWebSocket.instances.length = 0;
  }

  static get latest(): TrackedWebSocket | undefined {
    return TrackedWebSocket.instances[TrackedWebSocket.instances.length - 1];
  }

  get readyState(): number {
    return this.raw.readyState;
  }

  get bufferedAmount(): number {
    return this.raw.bufferedAmount;
  }

  send(data: string): void {
    this.raw.send(data);
  }

  close(code?: number, reason?: string): void {
    this.raw.close(code, reason);
  }

  /** Drop the connection without a close handshake (a network blip). */
  terminate(): void {
    this.raw.terminate();
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    this.raw.addEventListener(
      type as 'open',
      listener as unknown as (event: unknown) => void as never,
    );
  }
}
