const { cloneValue } = require('../../dist/utils/clone');

function createTypeScriptDemoAdapter() {
  let context;
  const publishedDiagnostics = new Set();

  const ensureContext = () => {
    if (!context) {
      throw new Error('TypeScript demo adapter not initialized.');
    }
    return context;
  };

  const ensureDocument = (uri) => ensureContext().getDocument(uri);

  const inferTypeFromLine = (line) => {
    if (/=>\s*`/.test(line)) {
      return '(name: string) => string';
    }
    if (/return\s+/.test(line)) {
      return 'string';
    }
    if (/\[/.test(line) && /\]/.test(line)) {
      return 'string[]';
    }
    if (/:\s*string/.test(line)) {
      return 'string';
    }
    return 'unknown';
  };

  const ensureDeclarations = (text) => {
    const lines = text.split('\n');
    const declarations = [];
    lines.forEach((line, index) => {
      const match = line.match(/^(?:export\s+)?(const|let|var|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?/);
      if (match) {
        const [, kind, name, typeAnnotation] = match;
        const character = line.indexOf(name);
        declarations.push({
          name,
          line: index,
          character,
          kind,
          type: (typeAnnotation || inferTypeFromLine(line)).trim(),
        });
      }
    });
    return declarations;
  };

  const publishDiagnosticsOnce = (uri) => {
    if (!uri || publishedDiagnostics.has(uri)) return;
    const doc = ensureDocument(uri);
    if (!doc) return;
    publishedDiagnostics.add(uri);
    ensureContext().publishDiagnostics(uri, [
      {
        message: 'Enable strict mode for better TypeScript checking.',
        severity: 2,
        source: 'polylsp-demo',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: doc.text.split('\n')[0].length },
        },
      },
    ]);
  };

  const symbolAtPosition = (text, position) => {
    if (!position) return null;
    const lines = text.split('\n');
    const line = lines[position.line] ?? '';
    let index = Math.min(Math.max(position.character, 0), line.length);
    if (index > 0 && !isWordChar(line[index]) && isWordChar(line[index - 1])) {
      index -= 1;
    }
    let start = index;
    while (start > 0 && isWordChar(line[start - 1])) {
      start -= 1;
    }
    let end = index;
    while (end < line.length && isWordChar(line[end])) {
      end += 1;
    }
    if (start === end) return null;
    return line.slice(start, end);
  };

  const makeWorkspaceEdit = (uri, name, newName, text) => {
    const edits = [];
    const lines = text.split('\n');
    lines.forEach((line, lineIndex) => {
      let cursor = 0;
      while (cursor < line.length) {
        const index = line.indexOf(name, cursor);
        if (index === -1) break;
        const before = line[index - 1];
        const after = line[index + name.length];
        const boundaryBefore = !before || !/[A-Za-z0-9_]/.test(before);
        const boundaryAfter = !after || !/[A-Za-z0-9_]/.test(after);
        if (boundaryBefore && boundaryAfter) {
          edits.push({
            range: {
              start: { line: lineIndex, character: index },
              end: { line: lineIndex, character: index + name.length },
            },
            newText: newName,
          });
        }
        cursor = index + name.length;
      }
    });
    return { changes: { [uri]: edits } };
  };

  const isWordChar = (char) => typeof char === 'string' && /[A-Za-z0-9_]/.test(char);

  return {
    languageId: 'typescript',
    displayName: 'TypeScript Demo Adapter',
    capabilities: {
      completionProvider: { triggerCharacters: ['.', ':'] },
      definitionProvider: true,
      documentSymbolProvider: true,
      renameProvider: true,
    },
    initialize(adapterContext) {
      context = adapterContext;
      context.emitWorkspaceEvent('ts/configuration', { strict: true });
    },
    handlers: {
      getCompletions(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureDocument(uri);
        if (!doc) {
          return { isIncomplete: false, items: [] };
        }
        publishDiagnosticsOnce(uri);
        const declarations = ensureDeclarations(doc.text);
        return {
          isIncomplete: false,
          items: declarations.map((decl) => ({
            label: decl.name,
            kind: decl.kind === 'function' ? 3 : 6,
            detail: `${decl.name}: ${decl.type}`,
          })),
        };
      },
      getHover(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureDocument(uri);
        if (!doc) return { contents: [] };
        const symbol = symbolAtPosition(doc.text, params?.position);
        if (!symbol) return { contents: [] };
        const declarations = ensureDeclarations(doc.text);
        const decl = declarations.find((item) => item.name === symbol);
        const type = decl ? decl.type : 'unknown';
        return { contents: [`${symbol}: ${type}`] };
      },
      getDefinition(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureDocument(uri);
        if (!doc) return null;
        const symbol = symbolAtPosition(doc.text, params?.position);
        if (!symbol) return null;
        const declarations = ensureDeclarations(doc.text);
        const decl = declarations.find((item) => item.name === symbol);
        if (!decl) return null;
        const lineText = doc.text.split('\n')[decl.line] ?? '';
        return {
          uri,
          range: {
            start: { line: decl.line, character: decl.character },
            end: { line: decl.line, character: decl.character + decl.name.length },
          },
          selectionRange: {
            start: { line: decl.line, character: decl.character },
            end: { line: decl.line, character: decl.character + decl.name.length },
          },
          lineText,
        };
      },
      getDocumentSymbols(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureDocument(uri);
        if (!doc) return [];
        const lines = doc.text.split('\n');
        const declarations = ensureDeclarations(doc.text);
        return declarations.map((decl) => ({
          name: decl.name,
          kind: decl.kind === 'function' ? 12 : 13,
          range: {
            start: { line: decl.line, character: 0 },
            end: { line: decl.line, character: lines[decl.line]?.length ?? 0 },
          },
          selectionRange: {
            start: { line: decl.line, character: decl.character },
            end: { line: decl.line, character: decl.character + decl.name.length },
          },
          children: [],
        }));
      },
      renameSymbol(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureDocument(uri);
        if (!doc || typeof params?.newName !== 'string') {
          return { changes: {} };
        }
        const symbol = symbolAtPosition(doc.text, params?.position);
        if (!symbol) {
          return { changes: {} };
        }
        return makeWorkspaceEdit(uri, symbol, params.newName, doc.text);
      },
    },
  };
}

function runTypeScriptDemo() {
  const { createPolyClient, registerLanguage } = require('../../dist');
  const client = createPolyClient();
  const workspaceEvents = [];
  const diagnostics = [];

  const uri = 'file:///demo.ts';

  const workspaceSubscription = client.onWorkspaceEvent('ts/configuration', (event) => {
    workspaceEvents.push(cloneValue(event));
  });

  const diagnosticsSubscription = client.onDiagnostics(uri, (event) => {
    diagnostics.splice(0, diagnostics.length, ...event.diagnostics);
  });

  const adapter = createTypeScriptDemoAdapter();
  registerLanguage(client, adapter);

  const source = [
    'export const banner: string = "PolyLSP";',
    'export const greet = (name: string): string => `Hello, ${name}`;',
    'export const message: string = greet("PolyLSP");',
    'export function renderMessage(): string {',
    '  return message;',
    '}',
  ].join('\n');

  client.openDocument({ uri, languageId: 'typescript', text: source, version: 1 });

  const completionsBeforeRename = client.getCompletions({ textDocument: { uri }, position: { line: 2, character: 10 } });
  const hover = client.getHover({ textDocument: { uri }, position: { line: 1, character: 14 } });
  const definition = client.getDefinition({ textDocument: { uri }, position: { line: 2, character: 32 } });
  const renameEdit = client.renameSymbol({
    textDocument: { uri },
    position: { line: 2, character: 15 },
    newName: 'salutation',
  });
  const renameResult = client.applyWorkspaceEdit(renameEdit);
  const completionsAfterRename = client.getCompletions({ textDocument: { uri }, position: { line: 4, character: 12 } });
  const hoverAfterRename = client.getHover({ textDocument: { uri }, position: { line: 4, character: 11 } });

  diagnosticsSubscription.unsubscribe();
  workspaceSubscription.unsubscribe();
  client.dispose();

  return {
    completionsBeforeRename,
    hover,
    definition,
    renameEdit,
    renameResult,
    completionsAfterRename,
    hoverAfterRename,
    diagnostics,
    workspaceEvents,
  };
}

module.exports = {
  createTypeScriptDemoAdapter,
  runTypeScriptDemo,
};
