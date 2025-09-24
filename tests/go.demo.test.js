const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPolyClient, registerLanguage } = require('../dist');

const URI = 'file:///Users/qingyingliu/Code/PolyLSP/examples/go-demo/main.go';

// Simple test adapter that doesn't require external tools
function createTestGoAdapter() {
  return {
    languageId: 'go',
    handlers: {
      initialize: (ctx) => {
        // Just mark as initialized
      },
      getCompletions: (params) => ({
        isIncomplete: false,
        items: [{ label: 'Println', kind: 3 }, { label: 'Printf', kind: 3 }]
      }),
      getDefinition: (params) => ({
        uri: params.textDocument.uri,
        range: { start: { line: 4, character: 5 }, end: { line: 4, character: 9 } }
      }),
      findReferences: (params) => [
        { uri: params.textDocument.uri, range: { start: { line: 2, character: 9 }, end: { line: 2, character: 12 } } },
        { uri: params.textDocument.uri, range: { start: { line: 5, character: 1 }, end: { line: 5, character: 4 } } }
      ],
      formatDocument: (params) => [],
      getDocumentSymbols: (params) => [
        { name: 'main', kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } } }
      ]
    }
  };
}

test('Go demo workflow validates completions, references, and formatting', async () => {
  const client = createPolyClient({ workspaceFolders: ['/Users/qingyingliu/Code/PolyLSP/examples/go-demo'] });

  registerLanguage(client, createTestGoAdapter());

  const source = fs.readFileSync(path.join(__dirname, '../examples/go-demo/main.go'), 'utf8');

  client.openDocument({ uri: URI, languageId: 'go', text: source, version: 1 });

  const completions = await client.getCompletions({ textDocument: { uri: URI }, position: { line: 5, character: 5 } });

  const definition = await client.getDefinition({ textDocument: { uri: URI }, position: { line: 4, character: 5 } });

  const references = await client.findReferences({ textDocument: { uri: URI }, position: { line: 4, character: 5 } });

  const formatEdits = await client.formatDocument({ textDocument: { uri: URI } });

  const symbols = (await client.getDocumentSymbols({ textDocument: { uri: URI } })) || [];

  client.dispose();

  assert.ok(completions.items.length > 0);
  assert.ok(definition);
  assert.ok(references.length > 0);
  assert.ok(Array.isArray(formatEdits));
  assert.ok(symbols.length > 0);
  assert.ok(symbols.some((symbol) => symbol.name === 'main'));
});

test('Go adapter produces references for symbols in open documents', async () => {
  const client = createPolyClient({ workspaceFolders: ['/Users/qingyingliu/Code/PolyLSP/examples/go-demo'] });
  registerLanguage(client, createTestGoAdapter());

  const source = fs.readFileSync(path.join(__dirname, '../examples/go-demo/main.go'), 'utf8');

  client.openDocument({ uri: URI, languageId: 'go', text: source, version: 1 });

  const references = await client.findReferences({ textDocument: { uri: URI }, position: { line: 2, character: 9 } });

  const edits = await client.formatDocument({ textDocument: { uri: URI } });

  assert.ok(references.length > 0);
  assert.ok(Array.isArray(edits));

  client.dispose();
});
