export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

export type TextEdit = {
  range: Range;
  newText: string;
};

export type DocumentChange = {
  text: string;
  range?: Range;
};

export type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
};

export type Diagnostic = {
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
  range?: Range;
  data?: unknown;
};

export type DiagnosticsEvent = {
  uri: string;
  languageId: string;
  diagnostics: Diagnostic[];
};

export type WorkspaceEvent<T = unknown> = {
  kind: string;
  languageId: string;
  payload: T;
};

export type Listener<T> = (event: T) => void;

export interface Disposable {
  readonly closed: boolean;
  unsubscribe(): void;
}

export type MaybePromise<T> = T | Promise<T>;

export type TextDocument = {
  uri: string;
  languageId: string;
  text: string;
  version: number;
  openedAt: Date;
};

export type PolyClientOptions = {
  transport?: string;
  workspaceFolders?: string[];
  metadata?: Record<string, unknown>;
};

export type RequestContext = {
  languageId: string;
  options: PolyClientOptions;
  workspaceFolders: string[];
  getDocument(uri: string): TextDocument | null;
};

export type NotifyClient = (method: string, payload: unknown) => void;

export type LanguageRegistrationContext = {
  languageId: string;
  options: PolyClientOptions;
  publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
  emitWorkspaceEvent(kind: string, payload: unknown): void;
  getDocument(uri: string): TextDocument | null;
  listDocuments(): TextDocument[];
  getRegisteredLanguages(): string[];
  notifyClient: NotifyClient;
};

export type LanguageHandlers = {
  getCompletions?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  getHover?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  getDefinition?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  findReferences?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  getCodeActions?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  getDocumentHighlights?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  getDocumentSymbols?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  renameSymbol?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  formatDocument?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  formatRange?: (params: unknown, context: RequestContext) => MaybePromise<unknown>;
  sendRequest?: (method: string, params: unknown, context: RequestContext) => MaybePromise<unknown>;
  sendNotification?: (method: string, params: unknown, context: RequestContext) => MaybePromise<unknown>;
  [key: string]: unknown;
};

export type LanguageAdapter = {
  languageId: string;
  displayName?: string;
  capabilities?: Record<string, unknown>;
  initialize?: (context: LanguageRegistrationContext) => MaybePromise<unknown>;
  dispose?: () => void | Promise<void>;
  handlers?: LanguageHandlers;
  [key: string]: unknown;
};

export type RegisteredLanguage = {
  languageId: string;
  displayName: string;
  state: string;
  capabilities: Record<string, unknown>;
  registeredAt: Date;
};

export interface PolyClient {
  readonly options: PolyClientOptions;
  readonly transport: string;
  readonly workspaceFolders: string[];
  readonly metadata: Record<string, unknown>;
  registerLanguage(adapter: LanguageAdapter): MaybePromise<string>;
  unregisterLanguage(languageId: string): boolean;
  listLanguages(): RegisteredLanguage[];
  openDocument(doc: { uri: string; languageId: string; text?: string; version?: number }): TextDocument;
  updateDocument(update: { uri: string; version: number; changes: DocumentChange[] }): TextDocument;
  closeDocument(uri: string): boolean;
  getCompletions(params: unknown): MaybePromise<unknown>;
  getHover(params: unknown): MaybePromise<unknown>;
  getDefinition(params: unknown): MaybePromise<unknown>;
  findReferences(params: unknown): MaybePromise<unknown>;
  getCodeActions(params: unknown): MaybePromise<unknown>;
  getDocumentHighlights(params: unknown): MaybePromise<unknown>;
  getDocumentSymbols(params: unknown): MaybePromise<unknown>;
  renameSymbol(params: unknown): MaybePromise<unknown>;
  formatDocument(params: unknown): MaybePromise<unknown>;
  formatRange(params: unknown): MaybePromise<unknown>;
  sendRequest(method: string, params: unknown): MaybePromise<unknown>;
  sendNotification(method: string, params: unknown): MaybePromise<unknown>;
  onNotification(method: string, listener: Listener<unknown>): Disposable;
  onDiagnostics(uri: string, listener: Listener<DiagnosticsEvent>): Disposable;
  onWorkspaceEvent(kind: string, listener: Listener<WorkspaceEvent>): Disposable;
  applyWorkspaceEdit(edit: WorkspaceEdit): { applied: boolean; failures: { uri: string; reason: string }[] };
  dispose(): void;
}
