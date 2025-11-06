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

export type TextDocumentSyncKind = 0 | 1 | 2;

export type SaveOptions = {
  includeText?: boolean;
};

export type TextDocumentSyncOptions = {
  openClose?: boolean;
  change?: TextDocumentSyncKind;
  willSave?: boolean;
  willSaveWaitUntil?: boolean;
  save?: boolean | SaveOptions;
};

export type ChangeAnnotation = {
  label: string;
  needsConfirmation?: boolean;
  description?: string;
};

export type AnnotatedTextEdit = TextEdit & {
  annotationId?: string;
};

export type OptionalVersionedTextDocumentIdentifier = {
  uri: string;
  version?: number | null;
};

export type TextDocumentEdit = {
  textDocument: OptionalVersionedTextDocumentIdentifier;
  edits: (TextEdit | AnnotatedTextEdit)[];
};

export type CreateFile = {
  kind: 'create';
  uri: string;
  options?: {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
  };
};

export type RenameFile = {
  kind: 'rename';
  oldUri: string;
  newUri: string;
  options?: {
    overwrite?: boolean;
    ignoreIfExists?: boolean;
  };
};

export type DeleteFile = {
  kind: 'delete';
  uri: string;
  options?: {
    recursive?: boolean;
    ignoreIfNotExists?: boolean;
  };
};

export type WorkspaceDocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: WorkspaceDocumentChange[];
  changeAnnotations?: Record<string, ChangeAnnotation>;
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

export type AdapterErrorEvent = {
  languageId: string;
  operation: string;
  error: unknown;
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

export type HandleServerRequest = (method: string, params: unknown) => MaybePromise<unknown>;

export type ApplyWorkspaceEditResult = {
  applied: boolean;
  failures: { uri: string; reason: string }[];
  failureReason?: string;
  failedChange?: number;
};

export type LanguageRegistrationContext = {
  languageId: string;
  options: PolyClientOptions;
  publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
  emitWorkspaceEvent(kind: string, payload: unknown): void;
  getDocument(uri: string): TextDocument | null;
  listDocuments(): TextDocument[];
  getRegisteredLanguages(): string[];
  notifyClient: NotifyClient;
  handleServerRequest: HandleServerRequest;
  applyWorkspaceEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult;
  registerDisposable(dispose: () => void | Promise<void>): void;
};

export type LanguageHandlers = {
  initialize?: (context: LanguageRegistrationContext) => MaybePromise<unknown>;
  shutdown?: () => MaybePromise<void>;
  openDocument?: (params: { uri: string; languageId: string; text: string; version: number }) => MaybePromise<void>;
  updateDocument?: (params: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
    changes: DocumentChange[];
  }) => MaybePromise<void>;
  closeDocument?: (params: { uri: string }) => MaybePromise<void>;
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
  state: 'registering' | 'initializing' | 'ready' | 'failed' | 'disposed';
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
  onError(listener: Listener<AdapterErrorEvent>): Disposable;
  applyWorkspaceEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult;
  dispose(): MaybePromise<void>;
}
