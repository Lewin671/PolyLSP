const { applyTextEdits } = require('../../dist/utils/textEdit');
const { cloneValue } = require('../../dist/utils/clone');

function createGoDemoAdapter() {
  let context;

  const ensureContext = () => {
    if (!context) {
      throw new Error('Go demo adapter not initialized.');
    }
    return context;
  };

  return {
    languageId: 'go',
    displayName: 'Go Demo Adapter',
    capabilities: {
      completionProvider: { triggerCharacters: ['.'] },
      definitionProvider: true,
      referencesProvider: true,
      documentFormattingProvider: true,
      documentSymbolProvider: true,
    },
    initialize(adapterContext) {
      context = adapterContext;
      context.emitWorkspaceEvent('go/configuration', { gofmt: true });
    },
    handlers: {
      getCompletions(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureContext().getDocument(uri);
        const items = [
          { label: 'fmt.Println', kind: 3, detail: 'Print formatted output.' },
          { label: 'sum', kind: 3, detail: 'Sum helper.' },
        ];
        if (doc?.text.includes('return')) {
          items.push({ label: 'return', kind: 14, detail: 'Go keyword' });
        }
        return { isIncomplete: false, items };
      },
      getDefinition(params) {
        const uri = params?.textDocument?.uri;
        if (!uri) return null;
        return {
          uri,
          range: {
            start: { line: 4, character: 0 },
            end: { line: 6, character: 1 },
          },
        };
      },
      getHover(params) {
        const symbol = symbolAtPosition(ensureContext().getDocument(params?.textDocument?.uri), params?.position);
        if (!symbol) return { contents: [] };
        return { contents: [`${symbol}(): func`] };
      },
      findReferences(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureContext().getDocument(uri);
        if (!doc) return [];
        const matches = findOccurrences(doc.text, 'sum');
        return matches.map((pos) => ({
          uri,
          range: {
            start: pos,
            end: { line: pos.line, character: pos.character + 3 },
          },
        }));
      },
      formatDocument(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureContext().getDocument(uri);
        if (!doc) return [];
        return buildFormattingEdits(doc.text);
      },
      getDocumentSymbols(params) {
        const uri = params?.textDocument?.uri;
        const doc = ensureContext().getDocument(uri);
        if (!doc) return [];
        return extractGoSymbols(doc.text);
      },
      sendRequest(method) {
        if (method === 'workspace/goVersion') {
          return { goVersion: '1.22' };
        }
        return null;
      },
    },
  };
}

function runGoDemo() {
  const { createPolyClient, registerLanguage } = require('../../dist');
  const client = createPolyClient();
  const workspaceEvents = [];
  const workspaceSubscription = client.onWorkspaceEvent('go/configuration', (event) => {
    workspaceEvents.push(cloneValue(event));
  });

  const adapter = createGoDemoAdapter();
  registerLanguage(client, adapter);

  const uri = 'file:///demo.go';
  const source = [
    'package demo',
    '',
    'import "fmt"',
    '',
    'func sum(a int, b int) int {',
    'return a + b',
    '}',
    '',
    'func main() {',
    'fmt.Println(sum(1, 2))',
    '}',
  ].join('\n');

  client.openDocument({ uri, languageId: 'go', text: source, version: 1 });

  const completions = client.getCompletions({ textDocument: { uri }, position: { line: 9, character: 12 } });
  const definition = client.getDefinition({ textDocument: { uri }, position: { line: 8, character: 5 } });
  const references = client.findReferences({ textDocument: { uri }, position: { line: 2, character: 6 } });
  const formatEdits = client.formatDocument({ textDocument: { uri } });
  const formatted = applyTextEdits(source, formatEdits);
  const symbols = client.getDocumentSymbols({ textDocument: { uri } }) || [];
  const requestResponse = client.sendRequest('workspace/goVersion', { textDocument: { uri } });

  workspaceSubscription.unsubscribe();
  client.dispose();

  return {
    completions,
    definition,
    references,
    formatEdits,
    formatted,
    symbols,
    workspaceEvents,
    requestResponse,
  };
}

function findOccurrences(text, token) {
  const lines = text.split('\n');
  const positions = [];
  lines.forEach((line, lineIndex) => {
    let cursor = line.indexOf(token);
    while (cursor !== -1) {
      positions.push({ line: lineIndex, character: cursor });
      cursor = line.indexOf(token, cursor + token.length);
    }
  });
  return positions;
}

function symbolAtPosition(doc, position) {
  if (!doc || !position) return null;
  const lines = doc.text.split('\n');
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
}

function isWordChar(char) {
  return typeof char === 'string' && /[A-Za-z0-9_]/.test(char);
}

function buildFormattingEdits(text) {
  const lines = text.split('\n');
  const edits = [];
  lines.forEach((line, index) => {
    if (line.trim().startsWith('return')) {
      const formatted = `    ${line.trim()}`;
      if (formatted !== line) {
        edits.push({
          range: {
            start: { line: index, character: 0 },
            end: { line: index, character: line.length },
          },
          newText: formatted,
        });
      }
    }
  });
  return edits;
}

function extractGoSymbols(text) {
  const lines = text.split('\n');
  const symbols = [];
  lines.forEach((line, index) => {
    const funcMatch = line.match(/^func\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (funcMatch) {
      const name = funcMatch[1];
      symbols.push({
        name,
        kind: 12,
        range: {
          start: { line: index, character: 0 },
          end: { line: index, character: line.length },
        },
        selectionRange: {
          start: { line: index, character: line.indexOf(name) },
          end: { line: index, character: line.indexOf(name) + name.length },
        },
        children: [],
      });
    }
  });
  return symbols;
}

module.exports = {
  createGoDemoAdapter,
  runGoDemo,
};
