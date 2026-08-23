/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
  currentAccountId,
  currentOperatorAccess,
  runWithAccount,
  runWithOperatorAccess,
  type AccountId,
  type OperatorAccess,
} from '@deepseek-ai/dsh-account'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

type Frame = MuxFrame | HostFrame

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function bindViewer<T>(
  account: AccountId | undefined,
  access: OperatorAccess | undefined,
  fn: () => T,
): T {
  if (access !== undefined) return runWithOperatorAccess(access, fn)
  return runWithAccount(account, fn)
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()

  /** @param api - host API supplying the typed event streams. */
  constructor(private readonly api: ApiProxy) {}

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const viewer = currentAccountId()
    const access = currentOperatorAccess()
    this.upgrade(req, socket, head, signal => bindViewer(viewer, access, () => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal)))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const viewer = currentAccountId()
    const access = currentOperatorAccess()
    this.upgrade(req, socket, head, signal => bindViewer(viewer, access, () => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal)))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    const viewer = currentAccountId()
    const access = currentOperatorAccess()
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      bindViewer(viewer, access, () => {
        const abort = new AbortController()
        websocket.once('close', () => { abort.abort() })
        websocket.once('error', () => { abort.abort() })
        websocket.once('message', () => {
          websocket.close(1008, 'downlink only')
        })
        const pump = this.pump(websocket, open(abort.signal), abort)
        this.pumps.add(pump)
        void pump.then(() => { this.pumps.delete(pump) })
      })
    })
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    frames: AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  rejectUpgrade(socket, 403, 'Forbidden', 'forbidden')
}

/**
 * Reject a WebSocket upgrade that presented no live Sign-in session.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 */
export function rejectUnauthorizedUpgrade(socket: Duplex): void {
  rejectUpgrade(socket, 401, 'Unauthorized', 'unauthorized')
}

function rejectUpgrade(socket: Duplex, status: number, reason: string, body: string): void {
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
