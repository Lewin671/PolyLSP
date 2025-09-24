const {
  createPolyClient,
  registerLanguage,
} = require('../src');

const GO_KEYWORDS = ['package', 'import', 'func', 'return', 'var'];
const GO_STD_COMPLETIONS = ['fmt.Println', 'fmt.Printf', 'fmt.Sprintf'];

function createGoDemoAdapter() {
  return {
    languageId: 'go',
    displayName: 'Go Demo',
    capabilities: {
      completionProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentFormattingProvider: true,
      documentSymbolProvider: true,
    },
    initialize(context) {
      context.emitWorkspaceEvent('go/config', { gofmt: true, goimports: true });
    },
    handlers: {
      getCompletions(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        const stems = [...new Set([...collectGoSymbols(doc.text), ...GO_STD_COMPLETIONS, ...GO_KEYWORDS])];
        const matches = stems.filter((label) => label.startsWith(word));
        return {
          isIncomplete: false,
          items: matches.map((label) => ({
            label,
            kind: label.includes('.') ? 2 : 14,
            detail: label.includes('.') ? 'std' : 'keyword/symbol',
          })),
        };
      },
      getDefinition(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        const range = findGoSymbolRange(doc.text, word);
        if (!range) return null;
        return { uri: doc.uri, range };
      },
      findReferences(params, context) {
        const doc = ensureDocument(context, params);
        const { word } = getWordAt(doc.text, params.position);
        const occurrences = collectWordRanges(doc.text, word);
        return occurrences.map((range) => ({ uri: doc.uri, range }));
      },
      formatDocument(params, context) {
        const doc = ensureDocument(context, params);
        const formatted = formatGoText(doc.text);
        if (formatted === doc.text) return [];
        return [
          {
            range: {
              start: { line: 0, character: 0 },
              end: offsetToPosition(doc.text, doc.text.length),
            },
            newText: formatted,
          },
        ];
      },
      getDocumentSymbols(params, context) {
        const doc = ensureDocument(context, params);
        return collectGoSymbols(doc.text)
          .filter((symbol) => !symbol.includes('.'))
          .map((name) => ({
            name,
            kind: 12,
            range: findGoSymbolRange(doc.text, name),
            selectionRange: findGoSymbolRange(doc.text, name),
          }));
      },
      sendRequest(method) {
        if (method === 'demo/go/environment') {
          return { goVersion: '1.22', modules: true };
        }
        throw new Error(`Unknown request ${method}`);
      },
    },
  };
}

function runGoDemo() {
  const client = createPolyClient({ metadata: { runtime: 'demo' } });
  const uri = 'file:///demo/main.go';
  const text = [
    'package main',
    '',
    'import "fmt"',
    '',
    'func add(a int, b int) int {',
    '  return a + b  ',
    '}',
    '',
    'func main() {',
    '  sum := add(1, 2)',
    ' fmt.Println(sum)',
    '}',
  ].join('\n');

  const workspaceEvents = [];
  client.onWorkspaceEvent('go/config', (event) => workspaceEvents.push(event));

  const adapter = createGoDemoAdapter();
  registerLanguage(client, adapter);

  client.openDocument({ uri, languageId: 'go', text, version: 1 });

  const completions = client.getCompletions({ uri, position: { line: 10, character: 8 } });
  const definition = client.getDefinition({ uri, position: { line: 9, character: 12 } });
  const references = client.findReferences({ textDocument: { uri }, position: { line: 4, character: 6 } });
  const formatEdits = client.formatDocument({ textDocument: { uri } });
  const formatted = applyTextEdits(text, formatEdits);
  const symbols = client.getDocumentSymbols({ textDocument: { uri } });
  const requestResponse = client.sendRequest('demo/go/environment', { uri });

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

function ensureDocument(context, params) {
  const uri = params.uri
    || (params.textDocument && params.textDocument.uri);
  const doc = context.getDocument(uri);
  if (!doc) {
    throw new Error(`Document ${uri} is not open.`);
  }
  return doc;
}

function collectGoSymbols(text) {
  const matches = [...text.matchAll(/func\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  const constants = [...text.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  return [...matches, ...constants].map((match) => match[1]);
}

function findGoSymbolRange(text, word) {
  if (!word) return null;
  const pattern = new RegExp(`func\\s+${word}\\b`, 'g');
  const match = pattern.exec(text);
  if (!match) return null;
  const start = match.index + match[0].indexOf(word);
  const end = start + word.length;
  return {
    start: offsetToPosition(text, start),
    end: offsetToPosition(text, end),
  };
}

function collectWordRanges(text, word) {
  if (!word) return [];
  const pattern = new RegExp(`\\b${word}\\b`, 'g');
  const ranges = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + word.length;
    ranges.push({
      start: offsetToPosition(text, start),
      end: offsetToPosition(text, end),
    });
  }
  return ranges;
}

function getWordAt(text, position) {
  const offset = positionToOffset(text, position);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_\.]/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[A-Za-z0-9_\.]/.test(text[end])) {
    end += 1;
  }
  return {
    word: text.slice(start, end),
    range: {
      start: offsetToPosition(text, start),
      end: offsetToPosition(text, end),
    },
  };
}

function formatGoText(text) {
  const lines = text.split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === '') {
        return '';
      }
      if (trimmed.startsWith('func ') || trimmed === '}') {
        return trimmed;
      }
      if (trimmed === 'package main' || trimmed.startsWith('import')) {
        return trimmed;
      }
      return `    ${trimmed}`;
    })
    .join('\n');
}

function applyTextEdits(text, edits) {
  if (!edits || edits.length === 0) {
    return text;
  }
  let output = text;
  const sorted = [...edits].sort((a, b) => {
    const offsetA = positionToOffset(text, a.range.start);
    const offsetB = positionToOffset(text, b.range.start);
    return offsetB - offsetA;
  });
  for (const edit of sorted) {
    const start = positionToOffset(output, edit.range.start);
    const end = positionToOffset(output, edit.range.end);
    output = output.slice(0, start) + edit.newText + output.slice(end);
  }
  return output;
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
  createGoDemoAdapter,
  runGoDemo,
  utils: {
    collectGoSymbols,
    collectWordRanges,
    formatGoText,
  },
};
