import { CLIENT_BRAND } from '../constants';
import { PolyClientError } from '../errors';
import {
  DiagnosticsEvent,
  DocumentChange,
  LanguageAdapter,
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
  state: 'registering' | 'initializing' | 'ready';
  initializedAt: Date;
  dispose?: () => void | Promise<void>;
  data: unknown;
};

export class PolyClient implements PolyClientApi {
  public transport: string;

  public workspaceFolders: string[];

  public metadata: Record<string, unknown>;

  private readonly languages = new Map<string, AdapterRecord>();

  private readonly documents = new Map<string, TextDocument>();

  private readonly diagnosticListeners = new Map<string, Set<Listener<DiagnosticsEvent>>>();

  private readonly workspaceListeners = new Map<string, Set<Listener<WorkspaceEvent>>>();

  private readonly notificationListeners = new Map<string, Set<NotificationListener>>();

  private readonly disposables = new Set<() => void>();

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

    const record: AdapterRecord = {
      languageId,
      adapter,
      displayName: adapter.displayName || languageId,
      capabilities: cloneValue(adapter.capabilities) || {},
      handlers: (adapter.handlers ?? adapter) as LanguageHandlers,
      state: 'registering',
      initializedAt: new Date(),
      dispose: adapter.dispose,
      data: {},
    };

    this.languages.set(languageId, record);

    if (typeof adapter.initialize === 'function') {
      const context = this.createAdapterContext(record);
      const result = adapter.initialize(context);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        record.state = 'initializing';
        return (result as Promise<unknown>)
          .then((value) => {
            record.state = 'ready';
            record.data = value ?? record.data;
            return record.languageId;
          })
          .catch((error) => {
            this.languages.delete(languageId);
            throw error;
          });
      }
      record.data = result ?? record.data;
    }

    record.state = 'ready';
    return record.languageId;
  }

  unregisterLanguage(languageId: string): boolean {
    this.assertNotDisposed();
    if (!this.languages.has(languageId)) {
      return false;
    }

    const record = this.languages.get(languageId)!;
    if (typeof record.dispose === 'function') {
      try {
        record.dispose();
      } catch (error) {
        this.languages.delete(languageId);
        throw error;
      }
    }

    this.languages.delete(languageId);
    return true;
  }

  listLanguages(): RegisteredLanguage[] {
    this.assertNotDisposed();
    return Array.from(this.languages.values()).map((record) => ({
      languageId: record.languageId,
      displayName: record.displayName,
      state: record.state,
      capabilities: cloneValue(record.capabilities),
      registeredAt: record.initializedAt,
    }));
  }

  openDocument({ uri, languageId, text = '', version = 1 }: {
    uri: string;
    languageId: string;
    text?: string;
    version?: number;
  }): TextDocument {
    this.assertNotDisposed();
    normalizeUri(uri);
    if (!this.languages.has(languageId)) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${languageId}" is not registered.`);
    }

    const doc: TextDocument = {
      uri,
      languageId,
      text: typeof text === 'string' ? text : '',
      version: version >>> 0,
      openedAt: new Date(),
    };

    this.documents.set(uri, doc);

    // Notify the language adapter about the opened document
    const record = this.languages.get(languageId);
    if (record && record.handlers.openDocument) {
      try {
        record.handlers.openDocument({ uri, languageId, text: doc.text, version: doc.version });
      } catch (error) {
        console.error(`Error notifying ${languageId} adapter about opened document:`, error);
      }
    }

    return cloneDocument(doc)!;
  }

  updateDocument({ uri, version, changes }: {
    uri: string;
    version: number;
    changes: DocumentChange[];
  }): TextDocument {
    this.assertNotDisposed();
    const doc = this.documents.get(normalizeUri(uri));
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
    return cloneDocument(doc)!;
  }

  closeDocument(uri: string): boolean {
    this.assertNotDisposed();
    const normalizedUri = normalizeUri(uri);
    const doc = this.documents.get(normalizedUri);

    if (doc) {
      // Notify the language adapter about the closed document
      const record = this.languages.get(doc.languageId);
      if (record && record.handlers.closeDocument) {
        try {
          record.handlers.closeDocument({ uri: normalizedUri });
        } catch (error) {
          console.error(`Error notifying ${doc.languageId} adapter about closed document:`, error);
        }
      }
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
    normalizeUri(uri);
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this.diagnosticListeners, uri);
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
        const document = this.documents.get(uri);
        if (!document) {
          failures.push({ uri, reason: 'Document not open' });
          continue;
        }
        try {
          const newText = applyTextEdits(document.text, edits);
          document.text = newText;
          document.version += 1;
        } catch (error) {
          failures.push({ uri, reason: (error as Error).message });
        }
      }
    }

    return { applied: failures.length === 0, failures };
  }

  dispose(): void {
    if (this.disposed) return;

    // Mark as disposed immediately to prevent new operations
    this.disposed = true;

    // Dispose all registered disposables
    for (const disposable of this.disposables) {
      try {
        disposable();
      } catch {
        // ignore dispose errors
      }
    }

    // Shutdown all language adapters (fire-and-forget for synchronous dispose)
    for (const record of this.languages.values()) {
      if (typeof record.dispose === 'function') {
        try {
          record.dispose();
        } catch {
          // ignore dispose errors
        }
      } else if (typeof record.handlers.shutdown === 'function') {
        try {
          record.handlers.shutdown();
        } catch {
          // ignore dispose errors
        }
      }
    }

    // Clean up immediately - don't wait for async operations
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
      return null;
    }

    const bag = params as Record<string, unknown>;

    const byLanguageId = this.extractLanguageId(bag);
    if (byLanguageId && this.languages.has(byLanguageId)) {
      return this.languages.get(byLanguageId) ?? null;
    }

    const byUri = this.extractUri(bag);
    if (byUri && this.documents.has(byUri)) {
      const document = this.documents.get(byUri)!;
      return this.languages.get(document.languageId) ?? null;
    }

    return null;
  }

  private extractLanguageId(data: Record<string, unknown>): string | undefined {
    if (typeof data.languageId === 'string') {
      return data.languageId;
    }
    const textDocument = data.textDocument as Record<string, unknown> | undefined;
    if (textDocument && typeof textDocument.languageId === 'string') {
      return textDocument.languageId;
    }
    return undefined;
  }

  private extractUri(data: Record<string, unknown>): string | undefined {
    if (typeof data.uri === 'string') {
      return data.uri;
    }
    const textDocument = data.textDocument as Record<string, unknown> | undefined;
    if (textDocument && typeof textDocument.uri === 'string') {
      return textDocument.uri;
    }
    const left = data.left as Record<string, unknown> | undefined;
    const leftDoc = left?.textDocument as Record<string, unknown> | undefined;
    if (leftDoc && typeof leftDoc.uri === 'string') {
      return leftDoc.uri;
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
      const doc = this.documents.get(uri);
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
    };
  }

  private createRequestContext(record: AdapterRecord): RequestContext {
    return {
      languageId: record.languageId,
      options: this.options,
      workspaceFolders: this.workspaceFolders.slice(),
      getDocument: (uri: string) => {
        const document = this.documents.get(uri);
        return cloneDocument(document);
      },
    };
  }

  private emitDiagnostics(uri: string, diagnostics: DiagnosticsEvent['diagnostics'], languageId: string): void {
    normalizeUri(uri);
    const listeners = this.diagnosticListeners.get(uri);
    if (!listeners || listeners.size === 0) return;
    const payload: DiagnosticsEvent = {
      uri,
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
