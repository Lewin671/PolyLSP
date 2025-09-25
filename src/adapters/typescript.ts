import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  DocumentChange,
  LanguageAdapter,
  LanguageRegistrationContext,
  LanguageHandlers,
} from '../types';
import { JsonRpcConnection } from '../utils/jsonRpc';

function resolveServerEntry(): string {
  const override = typeof process !== 'undefined' ? process.env?.POLY_TYPESCRIPT_LANGUAGE_SERVER_PATH : undefined;
  if (override && override.trim().length > 0) {
    const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '';
    return path.isAbsolute(override) ? override : path.resolve(cwd || '.', override);
  }
  try {
    return require.resolve('typescript-language-server/lib/cli.js');
  } catch (error) {
    throw new Error('Unable to resolve typescript-language-server. Please install "typescript-language-server" as a dependency.');
  }
}

type PendingNotification = { method: string; params: unknown };

type InitializationState = {
  result: unknown;
  timestamp: number;
};

const DEFAULT_REQUEST_TIMEOUT = 15000;

export function createTypeScriptAdapter(): LanguageAdapter {
  const serverEntry = resolveServerEntry();

  let child: ChildProcessWithoutNullStreams | null = null;
  let connection: JsonRpcConnection | null = null;
  let registrationContext: LanguageRegistrationContext | null = null;
  let initialized = false;
  let initializing: Promise<InitializationState> | null = null;
  let lastInitialization: InitializationState | null = null;
  const pendingNotifications: PendingNotification[] = [];

  const ensureConnection = () => {
    if (connection && child && !child.killed) {
      return connection;
    }

    child = spawn(process.execPath, [serverEntry, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    connection = new JsonRpcConnection(child.stdout, child.stdin, {
      label: 'typescript-language-server',
      requestTimeout: DEFAULT_REQUEST_TIMEOUT,
    });

    connection.on('notification', (message) => {
      if (!registrationContext || !message.method) {
        return;
      }

      if (message.method === 'textDocument/publishDiagnostics') {
        const params = (message.params ?? {}) as { uri?: string; diagnostics?: unknown };
        const diagnostics = Array.isArray((params as any).diagnostics) ? (params as any).diagnostics : [];
        if (typeof params.uri === 'string') {
          registrationContext.publishDiagnostics(params.uri, diagnostics);
        }
        return;
      }

      registrationContext.notifyClient(message.method, message.params ?? {});
    });

    connection.on('error', (error) => {
      console.error('[typescript-language-server] connection error:', error);
    });

    connection.on('close', () => {
      initialized = false;
      initializing = null;
      connection?.removeAllListeners();
      connection = null;
      child = null;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      console.error('[typescript-language-server]', chunk.toString('utf8'));
    });

    child.on('error', (error) => {
      console.error('Failed to start typescript-language-server process:', error);
    });

    child.on('exit', () => {
      connection?.dispose();
      connection = null;
      child = null;
      initialized = false;
      initializing = null;
    });

    return connection;
  };

  const flushPendingNotifications = () => {
    if (!initialized || !connection) {
      return;
    }
    while (pendingNotifications.length > 0) {
      const next = pendingNotifications.shift()!;
      try {
        connection.sendNotification(next.method, next.params);
      } catch (error) {
        console.error('Failed to send buffered notification to typescript-language-server:', error);
      }
    }
  };

  const ensureInitialized = (ctx?: LanguageRegistrationContext | null): Promise<InitializationState> => {
    if (initialized && lastInitialization) {
      return Promise.resolve(lastInitialization);
    }

    if (!initializing) {
      initializing = (async () => {
        const context = ctx ?? registrationContext;
        const conn = ensureConnection();
        const workspaceFolder = context?.options.workspaceFolders?.[0];
        const rootUri = workspaceFolder ? pathToFileURL(workspaceFolder).toString() : null;
        const result = await conn.sendRequest('initialize', {
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

        conn.sendNotification('initialized', {});
        initialized = true;
        lastInitialization = { result, timestamp: Date.now() };
        flushPendingNotifications();
        return lastInitialization;
      })()
        .catch((error) => {
          initialized = false;
          lastInitialization = null;
          if (connection) {
            connection.dispose();
            connection = null;
          }
          if (child && !child.killed) {
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          }
          throw error;
        })
        .finally(() => {
          initializing = null;
        });
    }

    return initializing;
  };

  const sendNotification = (method: string, params: unknown) => {
    try {
      const conn = ensureConnection();
      if (!initialized) {
        pendingNotifications.push({ method, params });
        ensureInitialized().catch(() => undefined);
        return;
      }
      conn.sendNotification(method, params);
    } catch (error) {
      console.error(`Failed to send notification "${method}" to typescript-language-server:`, error);
    }
  };

  const sendRequest = async (method: string, params: unknown) => {
    await ensureInitialized();
    const conn = ensureConnection();
    return conn.sendRequest(method, params);
  };

  const disposeProcess = async () => {
    const current = child;
    const conn = connection;
    connection = null;
    child = null;
    initialized = false;
    initializing = null;
    lastInitialization = null;

    try {
      conn?.dispose();
    } catch {
      // ignore
    }

    if (!current) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const handleClose = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      current.on('close', handleClose);
      try {
        current.kill('SIGTERM');
      } catch {
        handleClose();
      }
    });
  };

  const handlers: LanguageHandlers = {
    initialize: async (ctx: LanguageRegistrationContext) => {
      registrationContext = ctx;
      const { result } = await ensureInitialized(ctx);
      return result;
    },
    shutdown: async () => {
      if (!connection) {
        return;
      }
      try {
        await Promise.race([
          connection.sendRequest('shutdown', {}),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        connection.sendNotification('exit', {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/connection disposed/i.test(message) && !/timed out/i.test(message)) {
          console.error('Error shutting down typescript-language-server:', error);
        }
      } finally {
        await disposeProcess();
      }
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
        ? params.changes.map((change) => ({
            range: change.range,
            text: change.text,
          }))
        : [{ text: params.text }];
      sendNotification('textDocument/didChange', {
        textDocument: { uri: params.uri, version: params.version },
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
    formatRange: (params: unknown) => sendRequest('textDocument/rangeFormatting', params),
    sendRequest,
    sendNotification: (method: string, params: unknown) => {
      ensureInitialized().catch(() => undefined);
      sendNotification(method, params);
    },
  };

  return {
    languageId: 'typescript',
    initialize: (ctx: LanguageRegistrationContext) => handlers.initialize!(ctx),
    handlers,
    dispose: async () => {
      pendingNotifications.length = 0;
      registrationContext = null;
      await disposeProcess();
    },
  };
}
