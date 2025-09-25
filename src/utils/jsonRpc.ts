import { EventEmitter } from 'events';

export type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type JsonRpcErrorPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcConnectionOptions = {
  requestTimeout?: number;
  encoding?: BufferEncoding;
  label?: string;
};

export type JsonRpcRequestOptions = {
  timeout?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout | null;
};

function subscribe(
  emitter: EventEmitter,
  event: string | symbol,
  listener: (...args: any[]) => void,
): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export class JsonRpcConnection extends EventEmitter {
  private readonly readable: NodeJS.ReadableStream;

  private readonly writable: NodeJS.WritableStream;

  private readonly encoding: BufferEncoding;

  private readonly label: string;

  private buffer = '';

  private nextId = 0;

  private readonly pending = new Map<number | string, PendingRequest>();

  private closed = false;

  private readonly defaultTimeout: number;

  private readonly cleanupListeners: Array<() => void> = [];

  constructor(
    readable: NodeJS.ReadableStream,
    writable: NodeJS.WritableStream,
    options: JsonRpcConnectionOptions = {},
  ) {
    super();
    this.readable = readable;
    this.writable = writable;
    this.encoding = options.encoding ?? 'utf8';
    this.label = options.label ?? 'jsonrpc';
    this.defaultTimeout = options.requestTimeout ?? 15000;

    const onData = (chunk: Buffer | string) =>
      this.handleData(typeof chunk === 'string' ? chunk : chunk.toString(this.encoding));
    const onError = (error: unknown) => this.handleError(error);
    const onClose = () => this.handleClose();

    this.cleanupListeners.push(subscribe(this.readable as EventEmitter, 'data', onData));
    this.cleanupListeners.push(subscribe(this.readable as EventEmitter, 'error', onError));
    this.cleanupListeners.push(subscribe(this.readable as EventEmitter, 'end', onClose));
    this.cleanupListeners.push(subscribe(this.readable as EventEmitter, 'close', onClose));
    this.cleanupListeners.push(subscribe(this.writable as EventEmitter, 'error', onError));
  }

  sendNotification(method: string, params: unknown): void {
    if (this.closed) {
      throw new Error(`${this.label} connection is closed`);
    }
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeFrame(message);
  }

  async sendRequest(method: string, params: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      throw new Error(`${this.label} connection is closed`);
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const timeout = options.timeout ?? this.defaultTimeout;
    this.writeFrame(message);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) {
            return;
          }
          this.pending.delete(id);
          reject(new Error(`Request "${method}" timed out after ${timeout}ms.`));
        }, timeout);
      }

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupListeners.splice(0).forEach((cleanup) => cleanup());

    for (const [id, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error(`${this.label} connection disposed before response for id ${id}.`));
    }
    this.pending.clear();
    this.buffer = '';
  }

  private handleData(fragment: string): void {
    this.buffer += fragment;

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length: (\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const payload = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(payload) as JsonRpcMessage;
        this.emit('message', message);
        if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          if (message.error !== undefined && message.error !== null) {
            pending.reject(this.normalizeResponseError(message.error));
          } else {
            pending.resolve(message.result ?? null);
          }
          this.emit('response', message);
        } else if (message.method && message.id !== undefined && message.id !== null) {
          this.emit('request', message);
        } else if (message.method) {
          this.emit('notification', message);
        }
      } catch (error) {
        this.handleError(error);
      }
    }
  }

  private handleError(error: unknown): void {
    this.emit('error', error);
    if (this.closed) return;
    for (const [, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cleanup of this.cleanupListeners.splice(0)) {
      cleanup();
    }
    for (const [, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error(`${this.label} connection closed.`));
    }
    this.pending.clear();
    this.emit('close');
  }

  private writeFrame(payload: string): void {
    const content = `Content-Length: ${Buffer.byteLength(payload, this.encoding)}\r\n\r\n${payload}`;
    this.writable.write(content, this.encoding);
  }

  sendResponse(id: number | string, result: unknown): void {
    if (this.closed) {
      throw new Error(`${this.label} connection is closed`);
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null });
    this.writeFrame(message);
  }

  sendErrorResponse(id: number | string, error: unknown): void {
    if (this.closed) {
      throw new Error(`${this.label} connection is closed`);
    }
    const payload = this.normalizeErrorPayload(error);
    const message = JSON.stringify({ jsonrpc: '2.0', id, error: payload });
    this.writeFrame(message);
  }

  private normalizeResponseError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    if (error && typeof error === 'object') {
      const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
      const err = new Error(typeof message === 'string' ? message : 'JSON-RPC request failed');
      if (code !== undefined) {
        (err as Error & { code?: unknown }).code = code;
      }
      if (data !== undefined) {
        (err as Error & { data?: unknown }).data = data;
      }
      return err;
    }
    return new Error(typeof error === 'string' ? error : 'JSON-RPC request failed');
  }

  private normalizeErrorPayload(error: unknown): JsonRpcErrorPayload {
    if (error && typeof error === 'object' && 'code' in (error as Record<string, unknown>) && 'message' in (error as Record<string, unknown>)) {
      const { code, message, data } = error as { code: unknown; message: unknown; data?: unknown };
      return {
        code: typeof code === 'number' ? code : -32603,
        message: typeof message === 'string' ? message : 'Internal error',
        data,
      };
    }
    if (error instanceof Error) {
      return {
        code: -32603,
        message: error.message,
        data: { stack: error.stack },
      };
    }
    return {
      code: -32603,
      message: typeof error === 'string' ? error : 'Internal error',
      data: error,
    };
  }
}
