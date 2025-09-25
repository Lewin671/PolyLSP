import { CLIENT_BRAND } from '../constants';
import { PolyClientError } from '../errors';
import {
  AdapterErrorEvent,
  ApplyWorkspaceEditResult,
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
  TextDocumentEdit,
  TextEdit,
  WorkspaceDocumentChange,
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
  operationQueue: QueuedOperation[];
};

type QueuedOperation = {
  operation: string;
  handler: ((...args: any[]) => MaybePromise<unknown>) | undefined;
  args: any[];
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

  private readonly errorListeners = new Set<Listener<AdapterErrorEvent>>();

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
      operationQueue: [],
    };

    this.languages.set(languageId, record);

    const initialize = this.resolveInitialize(adapter, handlers);
    if (!initialize) {
      record.state = 'ready';
      record.initializedAt = new Date();
      this.flushQueuedOperations(record);
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
          this.flushQueuedOperations(record);
          return record.languageId;
        })
        .catch((error) => {
          record.state = 'failed';
          record.initializationError = error;
          this.flushQueuedOperations(record, error);
          this.languages.delete(languageId);
          this.emitAdapterError('initialize', languageId, error);
          const cleanup = this.runRecordDisposables(record, true);
          if (this.isThenable(cleanup)) {
            cleanup.catch(() => undefined);
          }
          throw error;
        });
    }

    record.state = 'ready';
    record.initializedAt = new Date();
    record.data = result ?? record.data;
    this.flushQueuedOperations(record);
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

    if (!Array.isArray(changes)) {
      throw new PolyClientError('INVALID_CHANGES', 'Document changes must be an array.');
    }

    let text = doc.text;
    if (changes.length > 0) {
      for (const change of changes) {
        text = applyContentChange(text, change);
      }
      doc.text = text;
    }

    doc.version = version;
    const record = this.languages.get(doc.languageId);
    const outgoingChanges =
      changes.length > 0
        ? cloneValue(changes)
        : [{ text: doc.text }];
    this.callAdapterHandler(record, 'updateDocument', record?.handlers.updateDocument, {
      uri: doc.uri,
      languageId: doc.languageId,
      version: doc.version,
      text: doc.text,
      changes: outgoingChanges,
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
    const operation = `sendRequest:${method}`;
    const record = this.resolveLanguageFromParams(params, operation);
    this.assertLanguageReady(record, operation);
    const handler = record.handlers?.sendRequest;
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not handle sendRequest.`);
    }
    return handler(method, params, this.createRequestContext(record));
  }

  sendNotification(method: string, params: unknown = {}): MaybePromise<unknown> {
    this.assertNotDisposed();
    const operation = `sendNotification:${method}`;
    const record = this.resolveLanguageFromParams(params, operation);
    this.assertLanguageReady(record, operation);
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

  onError(listener: Listener<AdapterErrorEvent>): Subscription {
    this.assertNotDisposed();
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    this.errorListeners.add(listener);
    return new Subscription(() => this.errorListeners.delete(listener));
  }

  applyWorkspaceEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult {
    this.assertNotDisposed();
    if (!edit || typeof edit !== 'object') {
      throw new PolyClientError('INVALID_EDIT', 'Workspace edit must be an object.');
    }

    const failures: { uri: string; reason: string }[] = [];
    let failedChangeIndex: number | undefined;

    const recordFailure = (uri: string, reason: string, index?: number) => {
      failures.push({ uri, reason });
      if (failedChangeIndex === undefined && typeof index === 'number' && Number.isInteger(index)) {
        failedChangeIndex = index;
      }
    };

    const handleTextDocumentEdit = (change: TextDocumentEdit, index: number) => {
      const uri = change?.textDocument?.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        recordFailure('', 'Missing textDocument URI', index);
        return;
      }
      let normalizedUri: string;
      try {
        normalizedUri = normalizeUri(uri);
      } catch (error) {
        recordFailure(uri, (error as Error).message, index);
        return;
      }
      const document = this.documents.get(normalizedUri);
      if (!document) {
        recordFailure(uri, 'Document not open', index);
        return;
      }
      const edits = Array.isArray(change.edits) ? change.edits : [];
      if (!edits.length) {
        return;
      }
      try {
        const normalizedEdits: TextEdit[] = [];
        for (const item of edits) {
          const range = (item as { range?: DocumentChange['range'] }).range;
          if (!range) {
            recordFailure(uri, 'Text edit range missing', index);
            return;
          }
          const newTextValue = (item as { newText?: string }).newText;
          normalizedEdits.push({ range, newText: typeof newTextValue === 'string' ? newTextValue : '' });
        }
        const newText = applyTextEdits(document.text, normalizedEdits);
        document.text = newText;
        document.version += 1;
        const record = this.languages.get(document.languageId);
        const changes = normalizedEdits.map((edit) => ({ range: edit.range, text: edit.newText }));
        this.callAdapterHandler(record, 'updateDocument', record?.handlers.updateDocument, {
          uri: document.uri,
          languageId: document.languageId,
          version: document.version,
          text: document.text,
          changes: changes.length > 0 ? changes : [{ text: document.text }],
        });
      } catch (error) {
        recordFailure(uri, (error as Error).message, index);
        if (typeof edit.documentChanges !== 'undefined') {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { index });
        }
      }
    };

    const processChange = (change: WorkspaceDocumentChange, index: number) => {
      if (!change || typeof change !== 'object') {
        return;
      }
      if ('kind' in change) {
        if (change.kind === 'rename') {
          const { oldUri, newUri } = change as { oldUri?: string; newUri?: string };
          if (typeof oldUri !== 'string' || typeof newUri !== 'string') {
            recordFailure(String(oldUri ?? newUri ?? ''), 'Invalid rename change', index);
            return;
          }
          let normalizedOld: string;
          let normalizedNew: string;
          try {
            normalizedOld = normalizeUri(oldUri);
            normalizedNew = normalizeUri(newUri);
          } catch (error) {
            recordFailure(oldUri, (error as Error).message, index);
            return;
          }
          if (!this.documents.has(normalizedOld)) {
            recordFailure(oldUri, 'Document not open', index);
            return;
          }
          const document = this.documents.get(normalizedOld)!;
          this.documents.delete(normalizedOld);
          document.uri = normalizedNew;
          this.documents.set(normalizedNew, document);
          const record = this.languages.get(document.languageId);
          this.callAdapterHandler(record, 'closeDocument', record?.handlers.closeDocument, { uri: normalizedOld });
          this.callAdapterHandler(record, 'openDocument', record?.handlers.openDocument, {
            uri: normalizedNew,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          });
          return;
        }
        recordFailure(
          'kind' in change && typeof (change as { uri?: string }).uri === 'string'
            ? (change as { uri: string }).uri
            : '',
          `Unsupported workspace edit change kind: ${(change as { kind: string }).kind}`,
          index,
        );
        return;
      }
      handleTextDocumentEdit(change as TextDocumentEdit, index);
    };

    let changeCounter = 0;

    try {
      if (Array.isArray(edit.documentChanges)) {
        edit.documentChanges.forEach((change) => {
          processChange(change, changeCounter);
          changeCounter += 1;
        });
      }
    } catch (error) {
      // Already recorded failure inside handlers
    }

    if (edit.changes && typeof edit.changes === 'object') {
      const entries = Object.entries(edit.changes);
      for (const [uri, edits] of entries) {
        const textDocumentEdit: TextDocumentEdit = {
          textDocument: { uri },
          edits: Array.isArray(edits) ? edits : [],
        };
        handleTextDocumentEdit(textDocumentEdit, changeCounter);
        changeCounter += 1;
      }
    }

    const result: ApplyWorkspaceEditResult = {
      applied: failures.length === 0,
      failures,
    };

    if (!result.applied && failures.length > 0) {
      result.failureReason = failures[0].reason;
      result.failedChange = failedChangeIndex ?? 0;
    }

    return result;
  }

  private async handleServerRequest(
    method: string,
    params: unknown,
    languageId: string,
  ): Promise<unknown> {
    switch (method) {
      case 'workspace/applyEdit': {
        const payload = (params ?? {}) as { edit?: WorkspaceEdit; label?: string };
        if (!payload || typeof payload !== 'object' || typeof payload.edit !== 'object') {
          return { applied: false, failureReason: 'Invalid workspace edit payload' };
        }
        const result = this.applyWorkspaceEdit(payload.edit as WorkspaceEdit);
        const response: Record<string, unknown> = { applied: result.applied };
        if (!result.applied) {
          response.failureReason = result.failureReason ?? 'Workspace edit failed';
          if (typeof result.failedChange === 'number') {
            response.failedChange = result.failedChange;
          }
        }
        return response;
      }
      case 'workspace/configuration': {
        const items = Array.isArray((params as { items?: unknown[] } | null | undefined)?.items)
          ? ((params as { items: unknown[] }).items)
          : [];
        return items.map(() => ({}));
      }
      case 'window/showMessageRequest': {
        const actions = Array.isArray((params as { actions?: unknown[] } | null | undefined)?.actions)
          ? ((params as { actions: unknown[] }).actions)
          : [];
        return actions.length > 0 ? actions[0] : null;
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/didChangeWorkspaceFolders':
        return null;
      case 'workspace/workspaceFolders': {
        return this.workspaceFolders.map((folder) => ({ uri: folder, name: folder.split(/[\\/]/).pop() ?? folder }));
      }
      default: {
        const listeners = this.notificationListeners.get(method);
        if (!listeners || listeners.size === 0) {
          return null;
        }
        let response: unknown = null;
        for (const listener of Array.from(listeners)) {
          try {
            const result = listener(params, languageId);
            if (result !== undefined) {
              response = result;
            }
          } catch {
            // Ignore listener failures for server requests
          }
        }
        return response ?? null;
      }
    }
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
    this.errorListeners.clear();
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

    if (record.state === 'registering' || record.state === 'initializing') {
      record.operationQueue.push({ operation, handler, args });
      return;
    }

    if (record.state !== 'ready') {
      return;
    }

    this.invokeHandler(record, operation, handler, args);
  }

  private invokeHandler<T>(
    record: AdapterRecord,
    operation: string,
    handler: ((...args: any[]) => MaybePromise<T>) | undefined,
    args: any[],
  ): void {
    if (typeof handler !== 'function') {
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

  private flushQueuedOperations(record: AdapterRecord, error?: unknown): void {
    if (!record.operationQueue.length) {
      return;
    }
    const queue = record.operationQueue.splice(0);
    if (error) {
      for (const item of queue) {
        this.handleAdapterError(item.operation, record.languageId, error);
      }
      return;
    }
    for (const item of queue) {
      this.invokeHandler(record, item.operation, item.handler, item.args);
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

    record.operationQueue.length = 0;

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
    this.emitAdapterError(operation, languageId, error);
  }

  private emitAdapterError(operation: string, languageId: string, error: unknown): void {
    if (this.errorListeners.size === 0) {
      return;
    }
    const event: AdapterErrorEvent = { languageId, operation, error };
    for (const listener of Array.from(this.errorListeners)) {
      try {
        listener(event);
      } catch (listenerError) {
        console.error('[PolyLSP] error listener failed:', listenerError);
      }
    }
  }

  private forward(handlerName: keyof LanguageHandlers, params: unknown): MaybePromise<unknown> {
    this.assertNotDisposed();
    const record = this.resolveLanguageFromParams(params, String(handlerName));
    this.assertLanguageReady(record, String(handlerName));
    const handler = record.handlers?.[handlerName];
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not implement ${String(handlerName)}.`);
    }
    return handler(params, this.createRequestContext(record));
  }

  private resolveLanguageFromParams(params: unknown, operation: string): AdapterRecord {
    if (!params || typeof params !== 'object') {
      if (this.languages.size === 1) {
        const only = this.languages.values().next().value as AdapterRecord | undefined;
        if (only) {
          return only;
        }
      }
      throw new PolyClientError(
        'LANGUAGE_NOT_RESOLVED',
        `Unable to resolve language for ${operation}: include a languageId or document URI.`,
      );
    }

    const bag = params as Record<string, unknown>;
    const byLanguageId = this.extractLanguageId(bag);
    if (byLanguageId) {
      const record = this.languages.get(byLanguageId);
      if (!record) {
        throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${byLanguageId}" is not registered.`);
      }
      return record;
    }

    const byUri = this.extractUri(bag);
    if (byUri) {
      const document = this.documents.get(byUri);
      if (!document) {
        throw new PolyClientError('DOCUMENT_NOT_OPEN', `Document "${byUri}" is not open.`);
      }
      const record = this.languages.get(document.languageId);
      if (!record) {
        throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${document.languageId}" is not registered.`);
      }
      return record;
    }

    if (this.languages.size === 1) {
      const only = this.languages.values().next().value as AdapterRecord | undefined;
      if (only) {
        return only;
      }
    }

    throw new PolyClientError(
      'LANGUAGE_NOT_RESOLVED',
      `Unable to resolve language for ${operation}: include a languageId or document URI.`,
    );
  }

  private assertLanguageReady(record: AdapterRecord, operation: string): void {
    if (record.state === 'ready') {
      return;
    }
    if (record.state === 'failed') {
      throw new PolyClientError('LANGUAGE_FAILED', `Language "${record.languageId}" failed to initialize.`);
    }
    if (record.state === 'disposed') {
      throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${record.languageId}" is not active.`);
    }
    throw new PolyClientError(
      'LANGUAGE_NOT_READY',
      `Language "${record.languageId}" is not ready to handle ${operation}.`,
    );
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
      handleServerRequest: (method: string, payload: unknown) =>
        this.handleServerRequest(method, payload, record.languageId),
      applyWorkspaceEdit: (workspaceEdit: WorkspaceEdit) => this.applyWorkspaceEdit(workspaceEdit),
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
