const test = require('node:test');
const assert = require('node:assert/strict');

const { runGoDemo, createGoDemoAdapter } = require('../examples/go-demo');
const { createPolyClient, registerLanguage } = require('../src');

const URI = 'file:///go-demo.go';

function setupGoClient() {
  const client = createPolyClient();
  const adapter = createGoDemoAdapter();
  registerLanguage(client, adapter);
  return client;
}

test('Go demo workflow validates completions, references, and formatting', () => {
  const result = runGoDemo();
  assert.ok(result.completions.items.some((item) => item.label === 'fmt.Println'));
  assert.equal(result.definition.range.start.line, 4);
  assert.equal(result.references.length >= 2, true);
  assert.ok(result.formatEdits.length >= 1);
  assert.ok(result.formatted.includes('    return a + b'));
  assert.ok(result.symbols.some((symbol) => symbol.name === 'main'));
  assert.equal(result.workspaceEvents[0].payload.gofmt, true);
  assert.equal(result.requestResponse.goVersion, '1.22');
});

test('Go adapter produces references for symbols in open documents', () => {
  const client = setupGoClient();
  const source = [
    'package demo',
    '',
    'func sum(a int, b int) int {',
    '    return a + b',
    '}',
    '',
    'func use() int {',
    '    return sum(1, 2)',
    '}',
  ].join('\n');

  client.openDocument({ uri: URI, languageId: 'go', text: source, version: 1 });

  const references = client.findReferences({ textDocument: { uri: URI }, position: { line: 2, character: 6 } });
  assert.equal(references.length, 2);

  const edits = client.formatDocument({ textDocument: { uri: URI } });
  assert.ok(Array.isArray(edits));

  client.dispose();
});
