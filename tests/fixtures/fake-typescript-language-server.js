#!/usr/bin/env node
const ts = require('typescript');
const { fileURLToPath, pathToFileURL } = require('node:url');
const path = require('node:path');

const documents = new Map();
let shutdownRequested = false;

const compilerOptions = {
  allowJs: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  jsx: ts.JsxEmit.React,
};

const languageService = ts.createLanguageService(
  {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => Array.from(documents.keys()),
    getScriptVersion: (fileName) => {
      const entry = documents.get(fileName);
      return entry ? String(entry.version) : '0';
    },
    getScriptSnapshot: (fileName) => {
      const entry = documents.get(fileName);
      if (entry) {
        return ts.ScriptSnapshot.fromString(entry.text);
      }
      if (ts.sys.fileExists(fileName)) {
        const content = ts.sys.readFile(fileName);
        if (typeof content === 'string') {
          return ts.ScriptSnapshot.fromString(content);
        }
      }
      return undefined;
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  },
  ts.createDocumentRegistry()
);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  processBuffer();
});

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.slice(0, headerEnd);
    const lengthMatch = header.match(/Content-Length: (\d+)/i);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(lengthMatch[1]);
    const total = headerEnd + 4 + length;
    if (buffer.length < total) {
      return;
    }
    const body = buffer.slice(headerEnd + 4, total);
    buffer = buffer.slice(total);
    try {
      const message = JSON.parse(body);
      handleMessage(message);
    } catch (error) {
      console.error('Failed to parse LSP payload', error);
    }
  }
}

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  const content = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  process.stdout.write(content);
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method, params) {
  sendMessage({ jsonrpc: '2.0', method, params });
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    sendResponse(message.id, {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
        },
        completionProvider: {},
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        renameProvider: true,
      },
    });
    return;
  }

  if (message.method === 'initialized') {
    return;
  }

  if (message.method === 'shutdown') {
    shutdownRequested = true;
    sendResponse(message.id, null);
    return;
  }

  if (message.method === 'exit') {
    process.exit(shutdownRequested ? 0 : 1);
  }

  if (message.method === 'textDocument/didOpen') {
    handleDidOpen(message.params);
    return;
  }

  if (message.method === 'textDocument/didChange') {
    handleDidChange(message.params);
    return;
  }

  if (message.method === 'textDocument/didClose') {
    handleDidClose(message.params);
    return;
  }

  if (message.id === undefined) {
    return;
  }

  switch (message.method) {
    case 'textDocument/completion':
      return handleCompletion(message.id, message.params);
    case 'textDocument/hover':
      return handleHover(message.id, message.params);
    case 'textDocument/definition':
      return handleDefinition(message.id, message.params);
    case 'textDocument/documentSymbol':
      return handleDocumentSymbol(message.id, message.params);
    case 'textDocument/rename':
      return handleRename(message.id, message.params);
    default:
      return sendError(message.id, -32601, `Unsupported method ${message.method}`);
  }
}

function handleDidOpen(params = {}) {
  const { textDocument } = params;
  if (!textDocument || typeof textDocument.uri !== 'string') {
    return;
  }
  const fileName = uriToPath(textDocument.uri);
  documents.set(fileName, { text: textDocument.text ?? '', version: textDocument.version ?? 1 });
  publishDiagnostics(textDocument.uri);
}

function handleDidChange(params = {}) {
  const { textDocument, contentChanges } = params;
  if (!textDocument || typeof textDocument.uri !== 'string') {
    return;
  }
  const fileName = uriToPath(textDocument.uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return;
  }
  let text = entry.text;
  if (Array.isArray(contentChanges)) {
    for (const change of contentChanges) {
      text = applyContentChange(text, change);
    }
  }
  const version = typeof textDocument.version === 'number' ? textDocument.version : entry.version + 1;
  documents.set(fileName, { text, version });
  publishDiagnostics(textDocument.uri);
}

function handleDidClose(params = {}) {
  const { textDocument } = params;
  if (!textDocument || typeof textDocument.uri !== 'string') {
    return;
  }
  const fileName = uriToPath(textDocument.uri);
  documents.delete(fileName);
  sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics: [] });
}

function handleCompletion(id, params = {}) {
  const uri = params.textDocument?.uri;
  if (typeof uri !== 'string') {
    return sendResponse(id, { items: [], isIncomplete: false });
  }
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return sendResponse(id, { items: [], isIncomplete: false });
  }
  const offset = positionToOffset(entry.text, params.position);
  const completions = languageService.getCompletionsAtPosition(fileName, offset, {});
  if (!completions) {
    return sendResponse(id, { items: [], isIncomplete: false });
  }
  const items = completions.entries.map((item) => ({
    label: item.name,
    kind: mapCompletionKind(item.kind),
    detail: item.kindModifiers?.length ? item.kindModifiers : undefined,
    sortText: item.sortText,
    insertText: item.insertText,
  }));
  sendResponse(id, { isIncomplete: false, items });
}

function handleHover(id, params = {}) {
  const uri = params.textDocument?.uri;
  if (typeof uri !== 'string') {
    return sendResponse(id, { contents: [] });
  }
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return sendResponse(id, { contents: [] });
  }
  const offset = positionToOffset(entry.text, params.position);
  const info = languageService.getQuickInfoAtPosition(fileName, offset);
  if (!info) {
    return sendResponse(id, { contents: [] });
  }
  const contents = ts.displayPartsToString(info.displayParts ?? []);
  sendResponse(id, { contents: [contents] });
}

function handleDefinition(id, params = {}) {
  const uri = params.textDocument?.uri;
  if (typeof uri !== 'string') {
    return sendResponse(id, null);
  }
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return sendResponse(id, null);
  }
  const offset = positionToOffset(entry.text, params.position);
  const definitions = languageService.getDefinitionAtPosition(fileName, offset);
  if (!definitions || definitions.length === 0) {
    return sendResponse(id, null);
  }
  const target = definitions[0];
  sendResponse(id, {
    uri: pathToUri(target.fileName),
    range: textSpanToRange(target.fileName, target.textSpan),
  });
}

function handleDocumentSymbol(id, params = {}) {
  const uri = params.textDocument?.uri;
  if (typeof uri !== 'string') {
    return sendResponse(id, []);
  }
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return sendResponse(id, []);
  }
  const tree = languageService.getNavigationTree(fileName);
  if (!tree) {
    return sendResponse(id, []);
  }
  const symbols = [];
  collectDocumentSymbols(tree, symbols, fileName);
  sendResponse(id, symbols);
}

function handleRename(id, params = {}) {
  const uri = params.textDocument?.uri;
  const newName = params.newName;
  if (typeof uri !== 'string' || typeof newName !== 'string') {
    return sendError(id, -32602, 'Invalid rename params');
  }
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return sendError(id, -32602, 'Document not open');
  }
  const offset = positionToOffset(entry.text, params.position);
  const locations = languageService.findRenameLocations(fileName, offset, false, false, true);
  if (!locations || locations.length === 0) {
    return sendError(id, -32602, 'Nothing to rename');
  }
  const changes = {};
  for (const location of locations) {
    const targetUri = pathToUri(location.fileName);
    const edits = changes[targetUri] ?? (changes[targetUri] = []);
    edits.push({
      range: textSpanToRange(location.fileName, location.textSpan),
      newText: newName,
    });
  }
  sendResponse(id, { changes });
}

function publishDiagnostics(uri) {
  const fileName = uriToPath(uri);
  const entry = documents.get(fileName);
  if (!entry) {
    return;
  }
  const syntactic = languageService.getSyntacticDiagnostics(fileName);
  const semantic = languageService.getSemanticDiagnostics(fileName);
  const all = syntactic.concat(semantic);
  const diagnostics = all.map((diagnostic) => ({
    range: textSpanToRange(fileName, diagnostic),
    severity: mapDiagnosticCategory(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    source: 'ts',
  }));
  sendNotification('textDocument/publishDiagnostics', { uri, diagnostics });
}

function applyContentChange(text, change = {}) {
  if (typeof change.text !== 'string') {
    return text;
  }
  if (!change.range) {
    return change.text;
  }
  const startOffset = positionToOffset(text, change.range.start);
  const endOffset = positionToOffset(text, change.range.end);
  return text.slice(0, startOffset) + change.text + text.slice(endOffset);
}

function positionToOffset(text, position = {}) {
  if (typeof position.line !== 'number' || typeof position.character !== 'number') {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    offset += lines[i].length + 1;
  }
  return offset + Math.min(position.character, lines[line]?.length ?? 0);
}

function textSpanToRange(fileName, span) {
  const start = span.start ?? (span.textSpan ? span.textSpan.start : 0);
  const length = span.length ?? (span.textSpan ? span.textSpan.length : 0);
  const scriptText = documents.get(fileName)?.text ?? ts.sys.readFile(fileName) ?? '';
  const sourceFile = ts.createSourceFile(fileName, scriptText, ts.ScriptTarget.ES2020, true);
  const startLoc = ts.getLineAndCharacterOfPosition(sourceFile, start);
  const endLoc = ts.getLineAndCharacterOfPosition(sourceFile, start + length);
  return {
    start: { line: startLoc.line, character: startLoc.character },
    end: { line: endLoc.line, character: endLoc.character },
  };
}

function collectDocumentSymbols(node, bucket, fileName) {
  if (!node || !Array.isArray(node.childItems)) {
    return;
  }
  for (const child of node.childItems) {
    const childSymbols = [];
    collectDocumentSymbols(child, childSymbols, fileName);
    const span = (child.spans && child.spans[0]) || child.textSpan;
    const selection = child.nameSpan || span;
    if (span && shouldIncludeSymbol(child.kind)) {
      const symbol = {
        name: child.text,
        kind: mapSymbolKind(child.kind),
        range: textSpanToRange(fileName, span),
        selectionRange: textSpanToRange(fileName, selection ?? span),
        children: childSymbols.length > 0 ? childSymbols : undefined,
      };
      bucket.push(symbol);
    } else if (childSymbols.length > 0) {
      bucket.push(...childSymbols);
    }
  }
}

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch (error) {
    return path.resolve(uri);
  }
}

function pathToUri(filePath) {
  return pathToFileURL(filePath).href;
}

function mapCompletionKind(kind) {
  switch (kind) {
    case ts.ScriptElementKind.methodElement:
      return 2;
    case ts.ScriptElementKind.functionElement:
      return 3;
    case ts.ScriptElementKind.constructorImplementationElement:
      return 4;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.variableElement:
      return 6;
    case ts.ScriptElementKind.classElement:
      return 7;
    case ts.ScriptElementKind.interfaceElement:
      return 8;
    case ts.ScriptElementKind.moduleElement:
      return 9;
    case ts.ScriptElementKind.enumElement:
      return 13;
    case ts.ScriptElementKind.keyword:
      return 14;
    default:
      return 1;
  }
}

function mapSymbolKind(kind) {
  switch (kind) {
    case 'module':
      return 2;
    case 'class':
      return 5;
    case 'interface':
      return 11;
    case 'enum':
      return 10;
    case 'function':
      return 12;
    case 'method':
      return 6;
    case 'property':
      return 7;
    case 'var':
      return 13;
    default:
      return 1;
  }
}

function shouldIncludeSymbol(kind) {
  switch (kind) {
    case 'class':
    case 'interface':
    case 'enum':
    case 'function':
    case 'method':
    case 'property':
    case 'var':
    case 'let':
    case 'const':
      return true;
    default:
      return false;
  }
}

function mapDiagnosticCategory(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 1;
    case ts.DiagnosticCategory.Warning:
      return 2;
    case ts.DiagnosticCategory.Suggestion:
      return 3;
    case ts.DiagnosticCategory.Message:
      return 4;
    default:
      return 1;
  }
}
