import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { DocumentChange, LanguageAdapter, LanguageRegistrationContext } from '../types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function resolveServerEntry(): string {
  const override = typeof process !== 'undefined' ? process.env?.POLY_TYPESCRIPT_LANGUAGE_SERVER_PATH : undefined;
  if (override && override.trim().length > 0) {
    const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '';
    return path.isAbsolute(override) ? override : path.resolve(cwd || '.', override);
  }
  try {
    return require.resolve('typescript-language-server/lib/cli.js');
  } catch (error) {
    throw new Error(
      'Unable to resolve typescript-language-server. Please install "typescript-language-server" as a dependency.'
    );
  }
}

export function createTypeScriptAdapter(): LanguageAdapter {
  const serverEntry = resolveServerEntry();

  let serverProcess: ChildProcess | null = null;
  let buffer = '';
  let requestId = 0;
  let initialized = false;
  let registrationContext: LanguageRegistrationContext | null = null;
  let initializationResult: unknown = null;
  let initPromise: Promise<unknown> | null = null;
  const pendingRequests = new Map<number, PendingRequest>();
  const pendingNotifications: { method: string; params: unknown }[] = [];

  const handleMessage = (message: any) => {
    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id)!;
      pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(message.error);
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics' && registrationContext) {
      const params = message.params ?? {};
      const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      registrationContext.publishDiagnostics(params.uri, diagnostics);
      return;
    }

    if (message.method && registrationContext) {
      registrationContext.notifyClient(message.method, message.params ?? {});
    }
  };

  const startServer = () => {
    serverProcess = spawn(process.execPath, [serverEntry, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    buffer = '';

    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = buffer.slice(0, headerEnd);
        const lengthMatch = header.match(/Content-Length: (\d+)/i);
        if (!lengthMatch) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(lengthMatch[1], 10);
        const totalLength = headerEnd + 4 + contentLength;
        if (buffer.length < totalLength) {
          break;
        }

        const payload = buffer.slice(headerEnd + 4, totalLength);
        buffer = buffer.slice(totalLength);

        try {
          const message = JSON.parse(payload);
          handleMessage(message);
        } catch (error) {
          console.error('Failed to parse LSP message from typescript-language-server:', error);
        }
      }
    });

    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[typescript-language-server]', chunk.toString());
    });

    serverProcess.on('error', (error) => {
      console.error('Failed to start typescript-language-server process:', error);
    });

    serverProcess.on('close', () => {
      serverProcess = null;
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('typescript-language-server exited'));
      }
      pendingRequests.clear();
      initialized = false;
      initPromise = null;
      initializationResult = null;
    });
  };

  const ensureServer = () => {
    if (!serverProcess) {
      startServer();
    }
  };

  const writeMessage = (payload: string) => {
    if (!serverProcess || !serverProcess.stdin || serverProcess.stdin.destroyed) {
      throw new Error('typescript-language-server process is not available.');
    }
    serverProcess.stdin.write(payload);
  };

  const stopServer = async () => {
    if (!serverProcess) {
      return;
    }
    const proc = serverProcess;
    await new Promise<void>((resolve) => {
      (proc as any).once('close', resolve);
      try {
        proc.kill('SIGTERM');
      } catch {
        resolve();
      }
    });
  };

  const sendRawRequest = (method: string, params: unknown): Promise<unknown> => {
    ensureServer();
    const id = ++requestId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`typescript-language-server request "${method}" timed out.`));
        }
      }, 15000);

      pendingRequests.set(id, { resolve, reject, timeout });
      try {
        writeMessage(content);
      } catch (error) {
        pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
        return;
      }
    });
  };

  const flushPendingNotifications = () => {
    if (!initialized || !serverProcess || !serverProcess.stdin || serverProcess.stdin.destroyed) {
      return;
    }
    while (pendingNotifications.length > 0) {
      const { method, params } = pendingNotifications.shift()!;
      const message = JSON.stringify({ jsonrpc: '2.0', method, params });
      const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
      writeMessage(content);
    }
  };

  const sendNotification = (method: string, params: unknown) => {
    if (!initialized) {
      pendingNotifications.push({ method, params });
      ensureServer();
      if (!initPromise) {
        ensureInitialized();
      }
      return;
    }

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    try {
      writeMessage(content);
    } catch (error) {
      console.error('Failed to send notification to typescript-language-server:', error);
    }
  };

  const ensureInitialized = (ctx?: LanguageRegistrationContext | null): Promise<unknown> => {
    if (initialized) {
      return Promise.resolve(initializationResult);
    }

    if (!initPromise) {
      initPromise = (async () => {
        const context = ctx ?? registrationContext;
        ensureServer();
        const workspaceFolder = context?.options.workspaceFolders?.[0];
        const rootUri = workspaceFolder ? `file://${workspaceFolder}` : null;
        const result = await sendRawRequest('initialize', {
          processId: process.pid ?? null,
          rootUri,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              completion: { dynamicRegistration: false },
              hover: { dynamicRegistration: false },
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              documentSymbol: { dynamicRegistration: false },
              rename: { dynamicRegistration: false },
              formatting: { dynamicRegistration: false },
            },
            workspace: { workspaceFolders: true },
          },
          initializationOptions: {
            preferences: {},
          },
          workspaceFolders: workspaceFolder ? [{ uri: rootUri, name: 'workspace' }] : [],
        });

        const message = JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} });
        const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
        writeMessage(content);

        initialized = true;
        initializationResult = result;
        flushPendingNotifications();
        return result;
      })().catch((error) => {
        initPromise = null;
        throw error;
      });
    }

    return initPromise;
  };

  const sendRequest = async (method: string, params: unknown): Promise<unknown> => {
    await ensureInitialized();
    return sendRawRequest(method, params);
  };

  const handlers = {
    shutdown: async () => {
      if (!serverProcess) return;
      if (initialized) {
        try {
          let timeoutHandle: ReturnType<typeof setTimeout>;
          await Promise.race([
            sendRequest('shutdown', {}).finally(() => {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
              }
            }),
            new Promise<void>((resolve) => {
              timeoutHandle = setTimeout(resolve, 2000);
            }),
          ]);
          sendNotification('exit', {});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/typescript-language-server (?:exited|shutdown)/i.test(message)) {
            console.error('Error shutting down typescript-language-server:', error);
          }
        }
      }

      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('typescript-language-server shutdown'));
      }
      pendingRequests.clear();

      await stopServer();
      initialized = false;
      registrationContext = null;
    },

    openDocument: (params: { uri: string; languageId: string; text: string; version: number }) => {
      ensureInitialized().catch(() => undefined);
      sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: params.uri,
          languageId: params.languageId,
          version: params.version,
          text: params.text,
        },
      });
    },

    updateDocument: (params: {
      uri: string;
      languageId: string;
      version: number;
      text: string;
      changes: DocumentChange[];
    }) => {
      ensureInitialized().catch(() => undefined);
      const contentChanges = Array.isArray(params.changes) && params.changes.length > 0
        ? params.changes.map((change) => {
            if (change.range) {
              return { range: change.range, text: change.text };
            }
            return { text: change.text };
          })
        : [{ text: params.text }];
      sendNotification('textDocument/didChange', {
        textDocument: {
          uri: params.uri,
          version: params.version,
        },
        contentChanges,
      });
    },

    closeDocument: (params: { uri: string }) => {
      ensureInitialized().catch(() => undefined);
      sendNotification('textDocument/didClose', {
        textDocument: { uri: params.uri },
      });
    },

    getCompletions: (params: unknown) => sendRequest('textDocument/completion', params),
    getHover: (params: unknown) => sendRequest('textDocument/hover', params),
    getDefinition: (params: unknown) => sendRequest('textDocument/definition', params),
    findReferences: (params: unknown) => sendRequest('textDocument/references', params),
    getDocumentSymbols: (params: unknown) => sendRequest('textDocument/documentSymbol', params),
    renameSymbol: (params: unknown) => sendRequest('textDocument/rename', params),
    formatDocument: (params: unknown) => sendRequest('textDocument/formatting', params),
  };

  return {
    languageId: 'typescript',
    initialize: async (ctx: LanguageRegistrationContext) => {
      registrationContext = ctx;
      return ensureInitialized(ctx);
    },
    handlers,
    dispose: async () => {
      await stopServer();
      for (const [, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
      }
      pendingRequests.clear();
      registrationContext = null;
      initializationResult = null;
      initPromise = null;
      pendingNotifications.length = 0;
      buffer = '';
    },
  };
}
