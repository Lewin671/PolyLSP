import { CLIENT_BRAND } from '../constants';
import { PolyClientError } from '../errors';
import {
  DiagnosticsEvent,
  DocumentChange,
  LanguageAdapter,
  LanguageRegistrationContext,
  LanguageHandlers,
  Listener,
  MaybePromise,
  PolyClient as PolyClientApi,
  PolyClientOptions,
  RegisteredLanguage,
  RequestContext,
  TextDocument,
  WorkspaceEdit,
  WorkspaceEvent,
} from '../types';
import { cloneDocument, cloneValue } from '../utils/clone';
import { normalizeUri } from '../utils/uri';
import { getOrCreateSet } from '../utils/maps';
import { applyContentChange, applyTextEdits } from '../utils/textEdit';
import { Subscription } from './subscription';

export type NotificationListener = (payload: unknown, languageId: string) => void;

type AdapterRecord = {
  languageId: string;
  adapter: LanguageAdapter;
  displayName: string;
  capabilities: Record<string, unknown>;
  handlers: LanguageHandlers;
  state: 'registering' | 'initializing' | 'ready' | 'failed' | 'disposed';
  registeredAt: Date;
  initializedAt: Date | null;
  dispose?: () => void | Promise<void>;
  data: unknown;
  disposables: Set<() => void | Promise<void>>;
  initializationError?: unknown;
};

const HANDLER_METHODS: (keyof LanguageHandlers)[] = [
  'initialize',
  'shutdown',
  'openDocument',
  'updateDocument',
  'closeDocument',
  'getCompletions',
  'getHover',
  'getDefinition',
  'findReferences',
  'getCodeActions',
  'getDocumentHighlights',
  'getDocumentSymbols',
  'renameSymbol',
  'formatDocument',
  'formatRange',
  'sendRequest',
  'sendNotification',
];

export class PolyClient implements PolyClientApi {
  public transport: string;

  public workspaceFolders: string[];

  public metadata: Record<string, unknown>;

  private readonly languages = new Map<string, AdapterRecord>();

  private readonly documents = new Map<string, TextDocument>();

  private readonly diagnosticListeners = new Map<string, Set<Listener<DiagnosticsEvent>>>();

  private readonly workspaceListeners = new Map<string, Set<Listener<WorkspaceEvent>>>();

  private readonly notificationListeners = new Map<string, Set<NotificationListener>>();

  private readonly disposables = new Set<() => void | Promise<void>>();

  private disposed = false;

  private readonly [CLIENT_BRAND] = true as const;

  constructor(options: PolyClientOptions = {}) {
    const {
      transport = 'stdio',
      workspaceFolders = [],
      metadata = {},
    } = options ?? {};

    if (!Array.isArray(workspaceFolders)) {
      throw new PolyClientError('INVALID_OPTIONS', 'workspaceFolders must be an array of strings.');
    }

    this.transport = transport;
    this.workspaceFolders = workspaceFolders.slice();
    this.metadata = { ...metadata };
  }

  get options(): PolyClientOptions {
    return {
      transport: this.transport,
      workspaceFolders: this.workspaceFolders.slice(),
      metadata: { ...this.metadata },
    };
  }

  registerLanguage(adapter: LanguageAdapter): MaybePromise<string> {
    this.assertNotDisposed();
    this.validateAdapter(adapter);

    const { languageId } = adapter;
    if (this.languages.has(languageId)) {
      throw new PolyClientError('LANGUAGE_EXISTS', `Language "${languageId}" is already registered.`);
    }

    const handlers: LanguageHandlers = { ...(adapter.handlers ?? {}) };
    if (!adapter.handlers) {
      for (const key of HANDLER_METHODS) {
        const candidate = (adapter as Record<string, unknown>)[key as string];
        if (typeof candidate === 'function') {
          handlers[key] = candidate as never;
        }
      }
    }

    const record: AdapterRecord = {
      languageId,
      adapter,
      displayName: adapter.displayName || languageId,
      capabilities: cloneValue(adapter.capabilities) || {},
      handlers,
      state: 'registering',
      registeredAt: new Date(),
      initializedAt: null,
      dispose: adapter.dispose,
      data: {},
      disposables: new Set(),
    };

    this.languages.set(languageId, record);

    const initialize = this.resolveInitialize(adapter, handlers);
    if (!initialize) {
      record.state = 'ready';
      record.initializedAt = new Date();
      return record.languageId;
    }

    record.state = 'initializing';
    const context = this.createAdapterContext(record);
    const result = initialize(context);
    if (this.isThenable(result)) {
      return result
        .then((value) => {
          record.state = 'ready';
          record.initializedAt = new Date();
          record.data = value ?? record.data;
          return record.languageId;
        })
        .catch((error) => {
          record.state = 'failed';
          record.initializationError = error;
          this.languages.delete(languageId);
          throw error;
        });
    }

    record.state = 'ready';
    record.initializedAt = new Date();
    record.data = result ?? record.data;
    return record.languageId;
  }

  unregisterLanguage(languageId: string): boolean {
    this.assertNotDisposed();
    if (!this.languages.has(languageId)) {
      return false;
    }

    const record = this.languages.get(languageId)!;
    record.state = 'disposed';
    this.languages.delete(languageId);
    try {
      const cleanup = this.runRecordDisposables(record, false);
      if (this.isThenable(cleanup)) {
        cleanup.catch((error) => {
          this.handleAdapterError('unregisterLanguage', record.languageId, error);
        });
      }
    } catch (error) {
      throw error;
    }
    return true;
  }

  listLanguages(): RegisteredLanguage[] {
    this.assertNotDisposed();
    return Array.from(this.languages.values()).map((record) => ({
      languageId: record.languageId,
      displayName: record.displayName,
      state: record.state,
      capabilities: cloneValue(record.capabilities),
      registeredAt: record.initializedAt ?? record.registeredAt,
    }));
  }

  openDocument({ uri, languageId, text = '', version = 1 }: {
    uri: string;
    languageId: string;
    text?: string;
    version?: number;
  }): TextDocument {
    this.assertNotDisposed();
    const normalizedUri = normalizeUri(uri);
    if (!this.languages.has(languageId)) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${languageId}" is not registered.`);
    }

    const doc: TextDocument = {
      uri: normalizedUri,
      languageId,
      text: typeof text === 'string' ? text : '',
      version: version >>> 0,
      openedAt: new Date(),
    };

    this.documents.set(normalizedUri, doc);

    const record = this.languages.get(languageId);
    this.callAdapterHandler(record, 'openDocument', record?.handlers.openDocument, {
      uri: normalizedUri,
      languageId,
      text: doc.text,
      version: doc.version,
    });

    return cloneDocument(doc)!;
  }

  updateDocument({ uri, version, changes }: {
    uri: string;
    version: number;
    changes: DocumentChange[];
  }): TextDocument {
    this.assertNotDisposed();
    const normalizedUri = normalizeUri(uri);
    const doc = this.documents.get(normalizedUri);
    if (!doc) {
      throw new PolyClientError('DOCUMENT_NOT_OPEN', `Document "${uri}" is not open.`);
    }

    if (typeof version !== 'number' || version <= doc.version) {
      throw new PolyClientError('INVALID_VERSION', 'Document version must be greater than current version.');
    }

    if (!Array.isArray(changes) || changes.length === 0) {
      throw new PolyClientError('INVALID_CHANGES', 'Document changes must be a non-empty array.');
    }

    let text = doc.text;
    for (const change of changes) {
      text = applyContentChange(text, change);
    }

    doc.text = text;
    doc.version = version;
    const record = this.languages.get(doc.languageId);
    this.callAdapterHandler(record, 'updateDocument', record?.handlers.updateDocument, {
      uri: doc.uri,
      languageId: doc.languageId,
      version: doc.version,
      text: doc.text,
      changes: cloneValue(changes),
    });
    return cloneDocument(doc)!;
  }

  closeDocument(uri: string): boolean {
    this.assertNotDisposed();
    const normalizedUri = normalizeUri(uri);
    const doc = this.documents.get(normalizedUri);

    if (doc) {
      const record = this.languages.get(doc.languageId);
      this.callAdapterHandler(record, 'closeDocument', record?.handlers.closeDocument, { uri: normalizedUri });
    }

    return this.documents.delete(normalizedUri);
  }

  getCompletions(params: unknown): MaybePromise<unknown> {
    return this.forward('getCompletions', params);
  }

  getHover(params: unknown): MaybePromise<unknown> {
    return this.forward('getHover', params);
  }

  getDefinition(params: unknown): MaybePromise<unknown> {
    return this.forward('getDefinition', params);
  }

  findReferences(params: unknown): MaybePromise<unknown> {
    return this.forward('findReferences', params);
  }

  getCodeActions(params: unknown): MaybePromise<unknown> {
    return this.forward('getCodeActions', params);
  }

  getDocumentHighlights(params: unknown): MaybePromise<unknown> {
    return this.forward('getDocumentHighlights', params);
  }

  getDocumentSymbols(params: unknown): MaybePromise<unknown> {
    return this.forward('getDocumentSymbols', params);
  }

  renameSymbol(params: unknown): MaybePromise<unknown> {
    return this.forward('renameSymbol', params);
  }

  formatDocument(params: unknown): MaybePromise<unknown> {
    return this.forward('formatDocument', params);
  }

  formatRange(params: unknown): MaybePromise<unknown> {
    return this.forward('formatRange', params);
  }

  sendRequest(method: string, params: unknown = {}): MaybePromise<unknown> {
    this.assertNotDisposed();
    const record = this.resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for request.');
    }
    const handler = record.handlers?.sendRequest;
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not handle sendRequest.`);
    }
    return handler(method, params, this.createRequestContext(record));
  }

  sendNotification(method: string, params: unknown = {}): MaybePromise<unknown> {
    this.assertNotDisposed();
    const record = this.resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for notification.');
    }
    const handler = record.handlers?.sendNotification;
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not handle sendNotification.`);
    }
    return handler(method, params, this.createRequestContext(record));
  }

  onNotification(method: string, listener: NotificationListener): Subscription {
    this.assertNotDisposed();
    if (typeof method !== 'string' || method.length === 0) {
      throw new PolyClientError('INVALID_NOTIFICATION', 'Notification method must be a non-empty string.');
    }
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this.notificationListeners, method);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  onDiagnostics(uri: string, listener: Listener<DiagnosticsEvent>): Subscription {
    this.assertNotDisposed();
    const normalizedUri = normalizeUri(uri);
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this.diagnosticListeners, normalizedUri);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  onWorkspaceEvent(kind: string, listener: Listener<WorkspaceEvent>): Subscription {
    this.assertNotDisposed();
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new PolyClientError('INVALID_EVENT_KIND', 'Event kind must be a non-empty string.');
    }
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this.workspaceListeners, kind);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  applyWorkspaceEdit(edit: WorkspaceEdit): { applied: boolean; failures: { uri: string; reason: string }[] } {
    this.assertNotDisposed();
    if (!edit || typeof edit !== 'object') {
      throw new PolyClientError('INVALID_EDIT', 'Workspace edit must be an object.');
    }

    const failures: { uri: string; reason: string }[] = [];

    if (edit.changes && typeof edit.changes === 'object') {
      const entries = Object.entries(edit.changes);
      for (const [uri, edits] of entries) {
        let normalizedUri: string;
        try {
          normalizedUri = normalizeUri(uri);
        } catch (error) {
          failures.push({ uri, reason: (error as Error).message });
          continue;
        }
        const document = this.documents.get(normalizedUri);
        if (!document) {
          failures.push({ uri, reason: 'Document not open' });
          continue;
        }
        try {
          const newText = applyTextEdits(document.text, edits);
          document.text = newText;
          document.version += 1;
          const record = this.languages.get(document.languageId);
          this.callAdapterHandler(record, 'updateDocument', record?.handlers.updateDocument, {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
            changes: [{ text: document.text }],
          });
        } catch (error) {
          failures.push({ uri, reason: (error as Error).message });
        }
      }
    }

    return { applied: failures.length === 0, failures };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.disposed = true;

    const cleanupTasks: Promise<void>[] = [];

    for (const disposable of this.disposables) {
      try {
        const result = disposable();
        if (this.isThenable(result)) {
          cleanupTasks.push(result.then(() => undefined).catch((error) => {
            this.handleAdapterError('dispose', 'client', error);
          }));
        }
      } catch (error) {
        this.handleAdapterError('dispose', 'client', error);
      }
    }
    this.disposables.clear();

    for (const record of this.languages.values()) {
      record.state = 'disposed';
      const result = this.runRecordDisposables(record, true);
      if (this.isThenable(result)) {
        cleanupTasks.push(result);
      }
    }

    if (cleanupTasks.length > 0) {
      await Promise.allSettled(cleanupTasks);
    }

    this.finalizeDispose();
  }

  private finalizeDispose(): void {
    this.languages.clear();
    this.documents.clear();
    this.diagnosticListeners.clear();
    this.workspaceListeners.clear();
    this.notificationListeners.clear();
    this.disposed = true;
  }

  private resolveInitialize(
    adapter: LanguageAdapter,
    handlers: LanguageHandlers,
  ): ((context: LanguageRegistrationContext) => MaybePromise<unknown>) | null {
    if (typeof adapter.initialize === 'function') {
      return (context) => adapter.initialize!(context);
    }
    if (typeof handlers.initialize === 'function') {
      return (context) => handlers.initialize!(context);
    }
    return null;
  }

  private callAdapterHandler<T>(
    record: AdapterRecord | undefined,
    operation: string,
    handler: ((...args: any[]) => MaybePromise<T>) | undefined,
    ...args: any[]
  ): void {
    if (!record || typeof handler !== 'function') {
      return;
    }
    try {
      const result = handler(...args);
      if (this.isThenable(result)) {
        result.catch((error) => this.handleAdapterError(operation, record.languageId, error));
      }
    } catch (error) {
      this.handleAdapterError(operation, record.languageId, error);
    }
  }

  private isThenable<T>(value: MaybePromise<T>): value is Promise<T> {
    return !!value && typeof (value as Promise<T>).then === 'function';
  }

  private tryNormalizeUri(uri: string | undefined | null): string | null {
    if (typeof uri !== 'string' || uri.length === 0) {
      return null;
    }
    try {
      return normalizeUri(uri);
    } catch {
      return null;
    }
  }

  private runRecordDisposables(record: AdapterRecord, suppressErrors: boolean): Promise<void> | void {
    const tasks: Promise<void>[] = [];

    const schedule = (fn: (() => void | Promise<void>) | undefined, label: string) => {
      if (typeof fn !== 'function') {
        return;
      }
      try {
        const result = fn();
        if (this.isThenable(result)) {
          const promise = result as Promise<void>;
          const task = suppressErrors
            ? promise.catch((error) => {
                this.handleAdapterError(label, record.languageId, error);
              })
            : promise;
          tasks.push(task.then(() => undefined));
        }
      } catch (error) {
        if (suppressErrors) {
          this.handleAdapterError(label, record.languageId, error);
        } else {
          throw error;
        }
      }
    };

    for (const dispose of Array.from(record.disposables)) {
      schedule(dispose, 'dispose');
    }
    record.disposables.clear();

    schedule(record.handlers.shutdown, 'shutdown');
    schedule(record.dispose, 'dispose');

    if (tasks.length === 0) {
      return undefined;
    }

    return Promise.allSettled(tasks).then((results) => {
      if (suppressErrors) {
        return;
      }
      for (const outcome of results) {
        if (outcome.status === 'rejected') {
          throw outcome.reason;
        }
      }
    });
  }

  private handleAdapterError(operation: string, languageId: string, error: unknown): void {
    console.error(`[PolyLSP:${languageId}] ${operation} failed:`, error);
  }

  private forward(handlerName: keyof LanguageHandlers, params: unknown): MaybePromise<unknown> {
    this.assertNotDisposed();
    const record = this.resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for request.');
    }
    const handler = record.handlers?.[handlerName];
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not implement ${String(handlerName)}.`);
    }
    return handler(params, this.createRequestContext(record));
  }

  private resolveLanguageFromParams(params: unknown): AdapterRecord | null {
    if (!params || typeof params !== 'object') {
      return this.languages.size === 1 ? this.languages.values().next().value ?? null : null;
    }

    const bag = params as Record<string, unknown>;

    const byLanguageId = this.extractLanguageId(bag);
    if (byLanguageId && this.languages.has(byLanguageId)) {
      return this.languages.get(byLanguageId) ?? null;
    }

    const byUri = this.extractUri(bag);
    if (byUri) {
      const document = this.documents.get(byUri);
      if (document) {
        return this.languages.get(document.languageId) ?? null;
      }
    }

    if (this.languages.size === 1) {
      return this.languages.values().next().value ?? null;
    }

    return byLanguageId ? this.languages.get(byLanguageId) ?? null : null;
  }

  private extractLanguageId(data: Record<string, unknown>): string | undefined {
    if (typeof data.languageId === 'string') {
      return data.languageId;
    }
    if (typeof data.language === 'string') {
      return data.language;
    }
    const textDocument = data.textDocument as Record<string, unknown> | undefined;
    if (textDocument && typeof textDocument.languageId === 'string') {
      return textDocument.languageId;
    }
    const document = data.document as Record<string, unknown> | undefined;
    if (document && typeof document.languageId === 'string') {
      return document.languageId;
    }
    return undefined;
  }

  private extractUri(data: Record<string, unknown>): string | undefined {
    const candidates: Array<string | undefined> = [
      typeof data.uri === 'string' ? data.uri : undefined,
      (data.textDocument as Record<string, unknown> | undefined)?.uri as string | undefined,
      (data.document as Record<string, unknown> | undefined)?.uri as string | undefined,
      ((data.left as Record<string, unknown> | undefined)?.textDocument as Record<string, unknown> | undefined)?.uri as string | undefined,
    ];

    for (const candidate of candidates) {
      const normalized = this.tryNormalizeUri(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private createAdapterContext(record: AdapterRecord) {
    const publishDiagnostics = (uri: string, diagnostics: DiagnosticsEvent['diagnostics']) => {
      this.emitDiagnostics(uri, diagnostics, record.languageId);
    };

    const emitWorkspaceEvent = (kind: string, payload: unknown) => {
      this.emitWorkspace(kind, payload, record.languageId);
    };

    const resolveDocument = (uri: string): TextDocument | null => {
      const normalized = this.tryNormalizeUri(uri);
      if (!normalized) {
        return null;
      }
      const doc = this.documents.get(normalized);
      return cloneDocument(doc);
    };

    const listDocuments = (): TextDocument[] => {
      return Array.from(this.documents.values())
        .filter((doc) => doc.languageId === record.languageId)
        .map((doc) => cloneDocument(doc)!)
        .filter((doc): doc is TextDocument => doc !== null);
    };

    return {
      languageId: record.languageId,
      options: this.options,
      publishDiagnostics,
      emitWorkspaceEvent,
      getDocument: resolveDocument,
      listDocuments,
      getRegisteredLanguages: () => this.listLanguages().map((item) => item.languageId),
      notifyClient: (method: string, payload: unknown) => {
        const listeners = this.notificationListeners.get(method);
        if (!listeners) return;
        for (const listener of Array.from(listeners)) {
          listener(payload, record.languageId);
        }
      },
      registerDisposable: (dispose: () => void | Promise<void>) => {
        if (typeof dispose !== 'function') {
          return;
        }
        record.disposables.add(dispose);
      },
    };
  }

  private createRequestContext(record: AdapterRecord): RequestContext {
    return {
      languageId: record.languageId,
      options: this.options,
      workspaceFolders: this.workspaceFolders.slice(),
      getDocument: (uri: string) => {
        const normalized = this.tryNormalizeUri(uri);
        if (!normalized) {
          return null;
        }
        const document = this.documents.get(normalized);
        return cloneDocument(document);
      },
    };
  }

  private emitDiagnostics(uri: string, diagnostics: DiagnosticsEvent['diagnostics'], languageId: string): void {
    const normalizedUri = normalizeUri(uri);
    const listeners = this.diagnosticListeners.get(normalizedUri);
    if (!listeners || listeners.size === 0) return;
    const payload: DiagnosticsEvent = {
      uri: normalizedUri,
      languageId,
      diagnostics: Array.isArray(diagnostics) ? cloneValue(diagnostics) : [],
    };
    for (const listener of Array.from(listeners)) {
      listener(payload);
    }
  }

  private emitWorkspace(kind: string, payload: unknown, languageId: string): void {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new PolyClientError('INVALID_EVENT_KIND', 'Event kind must be a non-empty string.');
    }
    const listeners = this.workspaceListeners.get(kind);
    if (!listeners || listeners.size === 0) return;
    const event: WorkspaceEvent = { kind, languageId, payload: cloneValue(payload) };
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }

  private validateAdapter(adapter: LanguageAdapter): void {
    if (!adapter || typeof adapter !== 'object') {
      throw new PolyClientError('INVALID_ADAPTER', 'Language adapter must be an object.');
    }
    if (typeof adapter.languageId !== 'string' || adapter.languageId.length === 0) {
      throw new PolyClientError('INVALID_ADAPTER', 'Language adapter must define a non-empty languageId.');
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new PolyClientError('CLIENT_DISPOSED', 'PolyLSP client is already disposed.');
    }
  }
}
