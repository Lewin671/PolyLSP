const {
  createPolyClient,
  registerLanguage,
} = require('../src');

const TS_KEYWORDS = ['const', 'let', 'function', 'interface', 'type', 'return'];

function createTypeScriptDemoAdapter() {
  const state = {
    publishDiagnostics: () => {},
  };
  return {
    languageId: 'typescript',
    displayName: 'TypeScript Demo',
    capabilities: {
      completionProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      renameProvider: true,
      documentSymbolProvider: true,
    },
    initialize(context) {
      context.emitWorkspaceEvent('ts/config', { strict: true, jsx: 'react' });
      state.publishDiagnostics = context.publishDiagnostics;
    },
    handlers: {
      getCompletions(params, context) {
        const doc = ensureDocument(context, params);
        const { word, range } = getWordAt(doc.text, params.position);
        const symbols = extractTypeScriptSymbols(doc.text);
        const suggestions = [...new Set([...symbols, ...TS_KEYWORDS])]
          .filter((item) => item.startsWith(word))
          .map((label) => ({
            label,
            kind: symbols.includes(label) ? 6 : 14,
            detail: symbols.includes(label) ? `symbol ${label}` : `keyword ${label}`,
          }));

        if (!word) {
          state.publishDiagnostics(doc.uri, [
            {
              message: 'Demo diagnostic: try adding a variable name.',
              severity: 2,
              range,
            },
          ]);
        } else {
          state.publishDiagnostics(doc.uri, []);
        }
        return {
          isIncomplete: false,
          items: suggestions,
        };
      },
      getHover(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        if (!word) {
          return { contents: [] };
        }
        const info = describeSymbol(doc.text, word);
        return {
          contents: [info],
        };
      },
      getDefinition(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        const definition = findDefinitionRange(doc.text, word);
        if (!definition) {
          return null;
        }
        return {
          uri: doc.uri,
          range: definition,
        };
      },
      renameSymbol(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        if (!word) {
          return { changes: {} };
        }
        const edits = collectWordEdits(doc.text, word, params.newName);
        return {
          changes: {
            [doc.uri]: edits,
          },
        };
      },
      getDocumentSymbols(params, context) {
        const doc = ensureDocument(context, params);
        return extractTypeScriptSymbols(doc.text).map((name) => ({
          name,
          kind: name[0] === name[0].toUpperCase() ? 2 : 13,
          range: findDefinitionRange(doc.text, name),
          selectionRange: findDefinitionRange(doc.text, name),
        }));
      },
    },
  };
}

function runTypeScriptDemo() {
  const client = createPolyClient({ workspaceFolders: ['./src'] });
  const uri = 'file:///demo.ts';
  const text = [
    "const greeting = 'hello';",
    'function greet(name: string) {',
    '  return `${greeting}, ${name}`;',
    '}',
    "const message = greet('Ada Lovelace');",
  ].join('\n');

  const diagnostics = [];
  const workspaceEvents = [];

  client.onDiagnostics(uri, (event) => diagnostics.push(event));
  client.onWorkspaceEvent('ts/config', (event) => workspaceEvents.push(event));

  const adapter = createTypeScriptDemoAdapter();
  registerLanguage(client, adapter);

  client.openDocument({ uri, languageId: 'typescript', text, version: 1 });

  const completionsBeforeRename = client.getCompletions({ uri, position: { line: 4, character: 18 } });
  const hover = client.getHover({ uri, position: { line: 1, character: 9 } });
  const definition = client.getDefinition({ uri, position: { line: 4, character: 19 } });

  const renameEdit = client.renameSymbol({
    textDocument: { uri },
    position: { line: 0, character: 6 },
    newName: 'salutation',
  });
  const renameResult = client.applyWorkspaceEdit(renameEdit);

  const completionsAfterRename = client.getCompletions({ uri, position: { line: 0, character: 9 } });
  const hoverAfterRename = client.getHover({ uri, position: { line: 0, character: 8 } });

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

function ensureDocument(context, params) {
  const uri = params.uri
    || (params.textDocument && params.textDocument.uri);
  const doc = context.getDocument(uri);
  if (!doc) {
    throw new Error(`Document ${uri} is not open.`);
  }
  return doc;
}

function extractTypeScriptSymbols(text) {
  const matches = [...text.matchAll(/(?:const|let|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  return matches.map((match) => match[1]);
}

function describeSymbol(text, word) {
  const definition = findDefinitionRange(text, word);
  if (!definition) {
    return `${word}: (unknown)`;
  }
  const startOffset = positionToOffset(text, definition.start);
  const lineStart = text.lastIndexOf('\n', startOffset);
  const prefixStart = lineStart === -1 ? 0 : lineStart + 1;
  const prefix = text.slice(prefixStart, startOffset);
  if (/function\s+$/.test(prefix)) {
    return `${word}: (name: string) => string`;
  }
  return `${word}: string`;
}

function findDefinitionRange(text, word) {
  if (!word) return null;
  const functionPattern = new RegExp(`function\\s+${word}\\b`, 'g');
  const constPattern = new RegExp(`(?:const|let)\\s+${word}\\b`, 'g');
  const patterns = [functionPattern, constPattern];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const startOffset = match.index + match[0].indexOf(word);
      const endOffset = startOffset + word.length;
      return {
        start: offsetToPosition(text, startOffset),
        end: offsetToPosition(text, endOffset),
      };
    }
  }
  return null;
}

function collectWordEdits(text, word, newName) {
  const edits = [];
  if (!word || !newName) return edits;
  const pattern = new RegExp(`\\b${word}\\b`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + word.length;
    edits.push({
      range: {
        start: offsetToPosition(text, start),
        end: offsetToPosition(text, end),
      },
      newText: newName,
    });
  }
  return edits;
}

function getWordAt(text, position) {
  const offset = positionToOffset(text, position);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
    end += 1;
  }
  const word = text.slice(start, end);
  return {
    word,
    range: {
      start: offsetToPosition(text, start),
      end: offsetToPosition(text, end),
    },
  };
}

function positionToOffset(text, position) {
  const lines = text.split('\n');
  const targetLine = Math.min(position.line, lines.length - 1);
  let offset = 0;
  for (let i = 0; i < targetLine; i += 1) {
    offset += lines[i].length + 1;
  }
  return offset + Math.min(position.character, lines[targetLine].length);
}

function offsetToPosition(text, offset) {
  const lines = text.split('\n');
  let remaining = offset;
  for (let line = 0; line < lines.length; line += 1) {
    const lineLength = lines[line].length + 1;
    if (remaining < lineLength) {
      return { line, character: Math.min(remaining, lines[line].length) };
    }
    remaining -= lineLength;
  }
  const lastLine = Math.max(lines.length - 1, 0);
  return { line: lastLine, character: lines[lastLine].length };
}

module.exports = {
  createTypeScriptDemoAdapter,
  runTypeScriptDemo,
  utils: {
    extractTypeScriptSymbols,
    collectWordEdits,
    findDefinitionRange,
    describeSymbol,
  },
};
