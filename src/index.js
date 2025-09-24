class PolyClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolyClientError';
    this.code = code;
  }
}

const CLIENT_BRAND = Symbol.for('polylsp.client');

function ensureClient(client) {
  if (!client || client[CLIENT_BRAND] !== true) {
    throw new PolyClientError('INVALID_CLIENT', 'Provided value is not a PolyLSP client instance.');
  }
}

function normalizeUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new PolyClientError('INVALID_URI', 'Document uri must be a non-empty string.');
  }
  return uri;
}

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value);
    } catch (_) {
      // fall back to JSON clone
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function cloneDocument(doc) {
  if (!doc) return null;
  return {
    uri: doc.uri,
    languageId: doc.languageId,
    text: doc.text,
    version: doc.version,
    openedAt: new Date(doc.openedAt.getTime()),
  };
}

class Subscription {
  constructor(unsubscribe) {
    this.closed = false;
    this._unsubscribe = unsubscribe;
  }

  unsubscribe() {
    if (this.closed) return;
    this.closed = true;
    if (typeof this._unsubscribe === 'function') {
      this._unsubscribe();
    }
  }
}

class PolyClient {
  constructor(options = {}) {
    const {
      transport = 'stdio',
      workspaceFolders = [],
      metadata = {},
    } = options || {};

    if (!Array.isArray(workspaceFolders)) {
      throw new PolyClientError('INVALID_OPTIONS', 'workspaceFolders must be an array of strings.');
    }

    this.transport = transport;
    this.workspaceFolders = workspaceFolders.slice();
    this.metadata = { ...metadata };

    this[CLIENT_BRAND] = true;
    this._languages = new Map();
    this._documents = new Map();
    this._diagnosticListeners = new Map(); // uri -> Set
    this._workspaceListeners = new Map(); // kind -> Set
    this._notificationListeners = new Map(); // method -> Set
    this._disposables = new Set();
    this._disposed = false;
  }

  get options() {
    return {
      transport: this.transport,
      workspaceFolders: this.workspaceFolders.slice(),
      metadata: { ...this.metadata },
    };
  }

  registerLanguage(adapter) {
    this._assertNotDisposed();
    this._validateAdapter(adapter);

    const { languageId } = adapter;
    if (this._languages.has(languageId)) {
      throw new PolyClientError('LANGUAGE_EXISTS', `Language "${languageId}" is already registered.`);
    }

    const record = {
      languageId,
      adapter,
      displayName: adapter.displayName || languageId,
      capabilities: cloneValue(adapter.capabilities) || {},
      handlers: adapter.handlers || adapter,
      state: 'registering',
      initializedAt: new Date(),
      dispose: adapter.dispose,
      data: {},
    };

    this._languages.set(languageId, record);

    if (typeof adapter.initialize === 'function') {
      const context = this._createAdapterContext(record);
      const result = adapter.initialize(context);
      if (result && typeof result.then === 'function') {
        record.state = 'initializing';
        return result
          .then((value) => {
            record.state = 'ready';
            record.data = value !== undefined ? value : record.data;
            return record.languageId;
          })
          .catch((error) => {
            this._languages.delete(languageId);
            throw error;
          });
      }
      record.data = result !== undefined ? result : record.data;
    }

    record.state = 'ready';
    return record.languageId;
  }

  unregisterLanguage(languageId) {
    this._assertNotDisposed();
    if (!this._languages.has(languageId)) {
      return false;
    }

    const record = this._languages.get(languageId);
    if (typeof record.dispose === 'function') {
      try {
        record.dispose();
      } catch (error) {
        this._languages.delete(languageId);
        throw error;
      }
    }

    this._languages.delete(languageId);
    return true;
  }

  listLanguages() {
    this._assertNotDisposed();
    return Array.from(this._languages.values()).map((record) => ({
      languageId: record.languageId,
      displayName: record.displayName,
      state: record.state,
      capabilities: cloneValue(record.capabilities),
      registeredAt: record.initializedAt,
    }));
  }

  openDocument({ uri, languageId, text = '', version = 1 }) {
    this._assertNotDisposed();
    normalizeUri(uri);
    if (!this._languages.has(languageId)) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', `Language "${languageId}" is not registered.`);
    }

    const doc = {
      uri,
      languageId,
      text: typeof text === 'string' ? text : '',
      version: version >>> 0,
      openedAt: new Date(),
    };

    this._documents.set(uri, doc);
    return cloneDocument(doc);
  }

  updateDocument({ uri, version, changes }) {
    this._assertNotDisposed();
    const doc = this._documents.get(normalizeUri(uri));
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
    return cloneDocument(doc);
  }

  closeDocument(uri) {
    this._assertNotDisposed();
    return this._documents.delete(normalizeUri(uri));
  }

  getCompletions(params) {
    return this._forward('getCompletions', params);
  }

  getHover(params) {
    return this._forward('getHover', params);
  }

  getDefinition(params) {
    return this._forward('getDefinition', params);
  }

  findReferences(params) {
    return this._forward('findReferences', params);
  }

  getCodeActions(params) {
    return this._forward('getCodeActions', params);
  }

  getDocumentHighlights(params) {
    return this._forward('getDocumentHighlights', params);
  }

  getDocumentSymbols(params) {
    return this._forward('getDocumentSymbols', params);
  }

  renameSymbol(params) {
    return this._forward('renameSymbol', params);
  }

  formatDocument(params) {
    return this._forward('formatDocument', params);
  }

  formatRange(params) {
    return this._forward('formatRange', params);
  }

  sendRequest(method, params = {}) {
    this._assertNotDisposed();
    const record = this._resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for request.');
    }
    const handler = record.handlers && record.handlers.sendRequest;
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not handle sendRequest.`);
    }
    return handler(method, params, this._createRequestContext(record));
  }

  sendNotification(method, params = {}) {
    this._assertNotDisposed();
    const record = this._resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for notification.');
    }
    const handler = record.handlers && record.handlers.sendNotification;
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not handle sendNotification.`);
    }
    return handler(method, params, this._createRequestContext(record));
  }

  onNotification(method, listener) {
    this._assertNotDisposed();
    if (typeof method !== 'string' || method.length === 0) {
      throw new PolyClientError('INVALID_NOTIFICATION', 'Notification method must be a non-empty string.');
    }
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this._notificationListeners, method);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  onDiagnostics(uri, listener) {
    this._assertNotDisposed();
    normalizeUri(uri);
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this._diagnosticListeners, uri);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  onWorkspaceEvent(kind, listener) {
    this._assertNotDisposed();
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new PolyClientError('INVALID_EVENT_KIND', 'Event kind must be a non-empty string.');
    }
    if (typeof listener !== 'function') {
      throw new PolyClientError('INVALID_LISTENER', 'Listener must be a function.');
    }
    const listeners = getOrCreateSet(this._workspaceListeners, kind);
    listeners.add(listener);
    return new Subscription(() => listeners.delete(listener));
  }

  applyWorkspaceEdit(edit) {
    this._assertNotDisposed();
    if (!edit || typeof edit !== 'object') {
      throw new PolyClientError('INVALID_EDIT', 'Workspace edit must be an object.');
    }
    const failures = [];

    if (edit.changes && typeof edit.changes === 'object') {
      const entries = Object.entries(edit.changes);
      for (const [uri, edits] of entries) {
        const document = this._documents.get(uri);
        if (!document) {
          failures.push({ uri, reason: 'Document not open' });
          continue;
        }
        try {
          const newText = applyTextEdits(document.text, edits);
          document.text = newText;
          document.version += 1;
        } catch (error) {
          failures.push({ uri, reason: error.message });
        }
      }
    }

    return { applied: failures.length === 0, failures };
  }

  dispose() {
    if (this._disposed) return;
    for (const disposable of this._disposables) {
      try {
        disposable();
      } catch (_) {
        // ignore dispose errors
      }
    }
    for (const record of this._languages.values()) {
      if (typeof record.dispose === 'function') {
        try {
          record.dispose();
        } catch (_) {
          // ignore dispose errors
        }
      }
    }
    this._languages.clear();
    this._documents.clear();
    this._diagnosticListeners.clear();
    this._workspaceListeners.clear();
    this._notificationListeners.clear();
    this._disposed = true;
  }

  _forward(handlerName, params) {
    this._assertNotDisposed();
    const record = this._resolveLanguageFromParams(params);
    if (!record) {
      throw new PolyClientError('UNKNOWN_LANGUAGE', 'Unable to resolve language for request.');
    }
    const handler = record.handlers && record.handlers[handlerName];
    if (typeof handler !== 'function') {
      throw new PolyClientError('FEATURE_UNSUPPORTED', `Language "${record.languageId}" does not implement ${handlerName}.`);
    }
    return handler(params, this._createRequestContext(record));
  }

  _resolveLanguageFromParams(params) {
    if (!params || typeof params !== 'object') {
      return null;
    }

    const languageId = params.languageId
      || (params.textDocument && params.textDocument.languageId);
    if (languageId && this._languages.has(languageId)) {
      return this._languages.get(languageId);
    }

    const uri = params.uri
      || (params.textDocument && params.textDocument.uri)
      || (params.left && params.left.textDocument && params.left.textDocument.uri);

    if (uri && this._documents.has(uri)) {
      const document = this._documents.get(uri);
      return this._languages.get(document.languageId) || null;
    }

    return null;
  }

  _createAdapterContext(record) {
    const publishDiagnostics = (uri, diagnostics) => {
      this._emitDiagnostics(uri, diagnostics, record.languageId);
    };

    const emitWorkspaceEvent = (kind, payload) => {
      this._emitWorkspace(kind, payload, record.languageId);
    };

    const resolveDocument = (uri) => {
      const doc = this._documents.get(uri);
      return cloneDocument(doc);
    };

    const listDocuments = () => {
      return Array.from(this._documents.values())
        .filter((doc) => doc.languageId === record.languageId)
        .map((doc) => cloneDocument(doc));
    };

    return {
      languageId: record.languageId,
      options: this.options,
      publishDiagnostics,
      emitWorkspaceEvent,
      getDocument: resolveDocument,
      listDocuments,
      getRegisteredLanguages: () => this.listLanguages().map((item) => item.languageId),
      notifyClient: (method, payload) => {
        const listeners = this._notificationListeners.get(method);
        if (!listeners) return;
        for (const listener of Array.from(listeners)) {
          listener(payload, record.languageId);
        }
      },
    };
  }

  _createRequestContext(record) {
    return {
      languageId: record.languageId,
      options: this.options,
      workspaceFolders: this.workspaceFolders.slice(),
      getDocument: (uri) => {
        const document = this._documents.get(uri);
        return cloneDocument(document);
      },
    };
  }

  _emitDiagnostics(uri, diagnostics, languageId) {
    normalizeUri(uri);
    const listeners = this._diagnosticListeners.get(uri);
    if (!listeners || listeners.size === 0) return;
    const payload = {
      uri,
      languageId,
      diagnostics: Array.isArray(diagnostics) ? cloneValue(diagnostics) : [],
    };
    for (const listener of Array.from(listeners)) {
      listener(payload);
    }
  }

  _emitWorkspace(kind, payload, languageId) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new PolyClientError('INVALID_EVENT_KIND', 'Event kind must be a non-empty string.');
    }
    const listeners = this._workspaceListeners.get(kind);
    if (!listeners || listeners.size === 0) return;
    const event = { kind, languageId, payload: cloneValue(payload) };
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }

  _validateAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') {
      throw new PolyClientError('INVALID_ADAPTER', 'Language adapter must be an object.');
    }
    if (typeof adapter.languageId !== 'string' || adapter.languageId.length === 0) {
      throw new PolyClientError('INVALID_ADAPTER', 'Language adapter must define a non-empty languageId.');
    }
  }

  _assertNotDisposed() {
    if (this._disposed) {
      throw new PolyClientError('CLIENT_DISPOSED', 'PolyLSP client is already disposed.');
    }
  }
}

function applyTextEdits(text, edits) {
  if (!Array.isArray(edits)) {
    throw new PolyClientError('INVALID_EDIT', 'Text edits must be an array.');
  }
  let result = text;
  const sorted = [...edits].map(validateTextEdit).sort(compareRangeReverse);
  for (const edit of sorted) {
    const start = offsetAt(result, edit.range.start);
    const end = offsetAt(result, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function applyContentChange(text, change) {
  if (!change || typeof change !== 'object') {
    throw new PolyClientError('INVALID_CHANGE', 'Document change must be an object.');
  }
  if (typeof change.text !== 'string') {
    throw new PolyClientError('INVALID_CHANGE', 'Document change is missing text property.');
  }
  if (!change.range) {
    return change.text;
  }
  const start = offsetAt(text, change.range.start);
  const end = offsetAt(text, change.range.end);
  return text.slice(0, start) + change.text + text.slice(end);
}

function validateTextEdit(edit) {
  if (!edit || typeof edit !== 'object') {
    throw new PolyClientError('INVALID_EDIT', 'Text edit must be an object.');
  }
  if (!edit.range || !edit.range.start || !edit.range.end) {
    throw new PolyClientError('INVALID_EDIT', 'Text edit range is missing.');
  }
  if (typeof edit.newText !== 'string') {
    throw new PolyClientError('INVALID_EDIT', 'Text edit newText must be a string.');
  }
  return edit;
}

function compareRangeReverse(a, b) {
  const diff = (b.range.start.line - a.range.start.line)
    || (b.range.start.character - a.range.start.character);
  return diff;
}

function offsetAt(text, position) {
  if (!position || typeof position.line !== 'number' || typeof position.character !== 'number') {
    throw new PolyClientError('INVALID_POSITION', 'Position must have numeric line and character.');
  }
  if (position.line < 0 || position.character < 0) {
    throw new PolyClientError('INVALID_POSITION', 'Position line and character must be non-negative.');
  }
  const lines = text.split('\n');
  if (position.line >= lines.length) {
    return text.length;
  }
  let offset = 0;
  for (let i = 0; i < position.line; i += 1) {
    offset += lines[i].length + 1;
  }
  const line = lines[position.line];
  return offset + Math.min(position.character, line.length);
}

function getOrCreateSet(map, key) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function createPolyClient(options) {
  return new PolyClient(options);
}

function registerLanguage(client, adapter) {
  ensureClient(client);
  return client.registerLanguage(adapter);
}

function unregisterLanguage(client, languageId) {
  ensureClient(client);
  return client.unregisterLanguage(languageId);
}

module.exports = {
  createPolyClient,
  registerLanguage,
  unregisterLanguage,
  PolyClientError,
};
