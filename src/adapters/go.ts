import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { pathToFileURL } from 'url';
import {
  DocumentChange,
  LanguageAdapter,
  LanguageHandlers,
  LanguageRegistrationContext,
  SaveOptions,
  TextDocumentSyncKind,
  TextDocumentSyncOptions,
  WorkspaceEdit,
} from '../types';
import { JsonRpcConnection } from '../utils/jsonRpc';

const DEFAULT_REQUEST_TIMEOUT = 10000;

type PendingNotification = { method: string; params: unknown };

type InitializationState = { result: unknown };

type ResolvedTextDocumentSync = {
  openClose: boolean;
  change: TextDocumentSyncKind;
  willSave: boolean;
  willSaveWaitUntil: boolean;
  save?: boolean | SaveOptions;
};

const TEXT_DOCUMENT_SYNC_KIND: Record<'None' | 'Full' | 'Incremental', TextDocumentSyncKind> = {
  None: 0,
  Full: 1,
  Incremental: 2,
};

const DEFAULT_TEXT_DOCUMENT_SYNC: ResolvedTextDocumentSync = {
  openClose: true,
  change: TEXT_DOCUMENT_SYNC_KIND.Incremental,
  willSave: false,
  willSaveWaitUntil: false,
};

function resolveTextDocumentSync(sync: unknown): ResolvedTextDocumentSync {
  const result: ResolvedTextDocumentSync = { ...DEFAULT_TEXT_DOCUMENT_SYNC };
  if (typeof sync === 'number') {
    if (sync === TEXT_DOCUMENT_SYNC_KIND.None) {
      result.change = TEXT_DOCUMENT_SYNC_KIND.None;
    } else if (sync === TEXT_DOCUMENT_SYNC_KIND.Full) {
      result.change = TEXT_DOCUMENT_SYNC_KIND.Full;
    } else {
      result.change = TEXT_DOCUMENT_SYNC_KIND.Incremental;
    }
    return result;
  }
  if (!sync || typeof sync !== 'object') {
    return result;
  }
  const options = sync as TextDocumentSyncOptions;
  if (typeof options.openClose === 'boolean') {
    result.openClose = options.openClose;
  }
  if (typeof options.change === 'number') {
    if (options.change === TEXT_DOCUMENT_SYNC_KIND.None) {
      result.change = TEXT_DOCUMENT_SYNC_KIND.None;
    } else if (options.change === TEXT_DOCUMENT_SYNC_KIND.Full) {
      result.change = TEXT_DOCUMENT_SYNC_KIND.Full;
    } else {
      result.change = TEXT_DOCUMENT_SYNC_KIND.Incremental;
    }
  }
  if (typeof options.willSave === 'boolean') {
    result.willSave = options.willSave;
  }
  if (typeof options.willSaveWaitUntil === 'boolean') {
    result.willSaveWaitUntil = options.willSaveWaitUntil;
  }
  if (typeof options.save === 'boolean' || (options.save && typeof options.save === 'object')) {
    result.save = options.save;
  }
  return result;
}

export function createGoAdapter(options: { goplsPath?: string } = {}): LanguageAdapter {
  const goplsPath = options.goplsPath || 'gopls';

  let processRef: ChildProcessWithoutNullStreams | null = null;
  let connection: JsonRpcConnection | null = null;
  let registrationContext: LanguageRegistrationContext | null = null;
  let initializing: Promise<InitializationState> | null = null;
  let initialized = false;
  let lastResult: InitializationState | null = null;
  const pendingNotifications: PendingNotification[] = [];
  let textDocumentSync: ResolvedTextDocumentSync = { ...DEFAULT_TEXT_DOCUMENT_SYNC };

  const ensureConnection = () => {
    if (connection && processRef && !processRef.killed) {
      return connection;
    }

    processRef = spawn(goplsPath, ['-mode=stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    connection = new JsonRpcConnection(processRef.stdout, processRef.stdin, {
      label: 'gopls',
      requestTimeout: DEFAULT_REQUEST_TIMEOUT,
    });

    connection.on('notification', (message) => {
      if (!message.method || !registrationContext) {
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

    connection.on('request', async (message) => {
      const activeConnection = connection;
      if (!registrationContext || !activeConnection || !message.method || message.id === undefined || message.id === null) {
        return;
      }
      try {
        if (message.method === 'workspace/applyEdit') {
          const params = (message.params ?? {}) as { edit?: WorkspaceEdit };
          if (!params || typeof params !== 'object' || typeof params.edit !== 'object') {
            activeConnection.sendErrorResponse(message.id, new Error('Invalid workspace/applyEdit payload'));
            return;
          }
          const result = registrationContext.applyWorkspaceEdit(params.edit as WorkspaceEdit);
          const response: Record<string, unknown> = { applied: result.applied };
          if (!result.applied) {
            response.failureReason = result.failureReason ?? 'Workspace edit failed';
            if (typeof result.failedChange === 'number') {
              response.failedChange = result.failedChange;
            }
          }
          activeConnection.sendResponse(message.id, response);
          return;
        }
        const result = await registrationContext.handleServerRequest(
          message.method,
          message.params ?? {},
        );
        activeConnection.sendResponse(message.id, result ?? null);
      } catch (error) {
        activeConnection.sendErrorResponse(message.id, error);
      }
    });

    connection.on('error', (error) => {
      console.error('[gopls] connection error:', error);
    });

    connection.on('close', () => {
      initialized = false;
      initializing = null;
      connection?.removeAllListeners();
      connection = null;
      processRef = null;
    });

    processRef.stderr?.on('data', (chunk: Buffer) => {
      console.error('[gopls]', chunk.toString('utf8'));
    });

    processRef.on('error', (error) => {
      console.error('Failed to start gopls process:', error);
    });

    processRef.on('exit', () => {
      connection?.dispose();
      connection = null;
      initialized = false;
      initializing = null;
      processRef = null;
    });

    return connection;
  };

  const flushPendingNotifications = () => {
    if (!initialized || !connection) {
      return;
    }
    while (pendingNotifications.length > 0) {
      const { method, params } = pendingNotifications.shift()!;
      try {
        connection.sendNotification(method, params);
      } catch (error) {
        console.error('Failed to send buffered notification to gopls:', error);
      }
    }
  };

  const ensureInitialized = (ctx?: LanguageRegistrationContext | null): Promise<InitializationState> => {
    if (initialized && lastResult) {
      return Promise.resolve(lastResult);
    }

    if (!initializing) {
      initializing = (async () => {
        const context = ctx ?? registrationContext;
        const conn = ensureConnection();
        const workspaceFolder = context?.options.workspaceFolders?.[0];
        const rootUri = workspaceFolder ? pathToFileURL(workspaceFolder).toString() : null;
        const result = await conn.sendRequest('initialize', {
          processId: processRef?.pid || null,
          rootUri,
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              completion: { dynamicRegistration: false },
              hover: { dynamicRegistration: false },
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              documentSymbol: { dynamicRegistration: false },
              formatting: { dynamicRegistration: false },
              rename: { dynamicRegistration: false },
            },
          workspace: { workspaceFolders: true },
        },
        workspaceFolders: workspaceFolder ? [{ uri: rootUri, name: 'workspace' }] : [],
      });

      const capabilities = (result as { capabilities?: { textDocumentSync?: unknown } } | null | undefined)?.capabilities;
      textDocumentSync = resolveTextDocumentSync(capabilities?.textDocumentSync);

      conn.sendNotification('initialized', {});
      initialized = true;
      lastResult = { result };
      flushPendingNotifications();
      return lastResult;
      })()
        .catch((error) => {
          initialized = false;
          lastResult = null;
          if (connection) {
            connection.dispose();
            connection = null;
          }
          if (processRef && !processRef.killed) {
            try {
              processRef.kill('SIGTERM');
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
      console.error(`Failed to send notification "${method}" to gopls:`, error);
    }
  };

  const sendRequest = async (method: string, params: unknown) => {
    await ensureInitialized();
    const conn = ensureConnection();
    return conn.sendRequest(method, params, { timeout: DEFAULT_REQUEST_TIMEOUT });
  };

  const shutdownProcess = async () => {
    const current = processRef;
    const conn = connection;
    processRef = null;
    connection = null;
    initializing = null;
    initialized = false;
    lastResult = null;
    textDocumentSync = { ...DEFAULT_TEXT_DOCUMENT_SYNC };

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
        await shutdownProcess();
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
          console.error('Error shutting down gopls:', error);
        }
      } finally {
        await shutdownProcess();
      }
    },
    openDocument: (params: { uri: string; languageId: string; text: string; version: number }) => {
      ensureInitialized().catch(() => undefined);
      if (textDocumentSync.openClose !== false) {
        sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: params.uri,
            languageId: params.languageId,
            version: params.version,
            text: params.text,
          },
        });
      }
    },
    updateDocument: (params: {
      uri: string;
      languageId: string;
      version: number;
      text: string;
      changes: DocumentChange[];
    }) => {
      ensureInitialized().catch(() => undefined);
      if (textDocumentSync.change === TEXT_DOCUMENT_SYNC_KIND.None) {
        return;
      }
      let contentChanges;
      if (textDocumentSync.change === TEXT_DOCUMENT_SYNC_KIND.Full) {
        contentChanges = [{ text: params.text }];
      } else if (Array.isArray(params.changes) && params.changes.length > 0) {
        contentChanges = params.changes.map((change) => ({ range: change.range, text: change.text }));
      } else {
        contentChanges = [{ text: params.text }];
      }
      sendNotification('textDocument/didChange', {
        textDocument: { uri: params.uri, version: params.version },
        contentChanges,
      });
    },
    closeDocument: (params: { uri: string }) => {
      ensureInitialized().catch(() => undefined);
      if (textDocumentSync.openClose !== false) {
        sendNotification('textDocument/didClose', {
          textDocument: { uri: params.uri },
        });
      }
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
    languageId: 'go',
    initialize: (ctx: LanguageRegistrationContext) => handlers.initialize!(ctx),
    handlers,
    dispose: async () => {
      pendingNotifications.length = 0;
      registrationContext = null;
      await shutdownProcess();
    },
  };
}
