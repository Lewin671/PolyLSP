const test = require('node:test');
const assert = require('node:assert/strict');

const { runTypeScriptDemo, createTypeScriptDemoAdapter } = require('../examples/typescript-demo');
const { createPolyClient, registerLanguage } = require('../src');

const URI = 'file:///ts-demo.ts';

function setupTypeScriptClient() {
  const client = createPolyClient();
  const adapter = createTypeScriptDemoAdapter();
  registerLanguage(client, adapter);
  return client;
}

test('TypeScript demo workflow exercises key APIs', () => {
  const result = runTypeScriptDemo();
  assert.ok(
    result.completionsBeforeRename.items.some((item) => item.label === 'greet'),
    'Completions should include TypeScript symbols',
  );
  assert.equal(result.hover.contents[0], 'greet: (name: string) => string');
  assert.equal(result.definition.range.start.line, 1);
  assert.equal(result.renameResult.applied, true);
  assert.ok(
    result.renameEdit.changes['file:///demo.ts'].length > 1,
    'Rename should produce multiple edits',
  );
  assert.ok(
    result.completionsAfterRename.items.some((item) => item.label === 'salutation'),
    'Completions after rename should include new symbol name',
  );
  assert.equal(result.hoverAfterRename.contents[0], 'salutation: string');
  assert.equal(result.diagnostics.length >= 1, true);
  assert.equal(result.workspaceEvents.length >= 1, true);
  assert.equal(result.workspaceEvents[0].payload.strict, true);
});

test('TypeScript adapter emits symbols and rename edits based on document text', () => {
  const client = setupTypeScriptClient();
  const source = [
    'const first = 1;',
    'const second = first + 1;',
  ].join('\n');
  client.openDocument({ uri: URI, languageId: 'typescript', text: source, version: 1 });

  const symbols = client.getDocumentSymbols({ textDocument: { uri: URI } });
  assert.deepEqual(
    symbols.map((symbol) => symbol.name),
    ['first', 'second'],
  );

  const renameEdit = client.renameSymbol({
    textDocument: { uri: URI },
    position: { line: 0, character: 6 },
    newName: 'primary',
  });
  assert.equal(renameEdit.changes[URI].length >= 1, true);

  client.dispose();
});
