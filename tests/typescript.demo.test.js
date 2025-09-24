const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPolyClient, registerLanguage } = require('../dist');
const { createTypeScriptAdapter } = require('../dist/adapters/typescript');

// Generate URI dynamically based on project root
const projectRoot = path.resolve(__dirname, '..');
const tsWorkspaceFolder = path.join(projectRoot, 'examples', 'ts-demo');
const tsExamplePath = path.join(tsWorkspaceFolder, 'src', 'index.ts');
const URI = `file://${tsExamplePath}`;

// Path to tsserver.js in node_modules
const tsserverPath = path.join(projectRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js');

function createTypeScriptHarness() {
  const client = createPolyClient({ workspaceFolders: [tsWorkspaceFolder] });
  const adapter = createTypeScriptAdapter({ tsserverPath });
  registerLanguage(client, adapter);
  const source = fs.readFileSync(tsExamplePath, 'utf8');
  client.openDocument({ uri: URI, languageId: 'typescript', text: source, version: 1 });
  return {
    client,
    uri: URI,
    dispose: () => client.dispose(),
  };
}

async function withTypeScriptHarness(run) {
  const harness = createTypeScriptHarness();
  try {
    await run(harness);
  } finally {
    harness.dispose();
  }
}

test('TypeScript adapter returns completions for open documents', async () => {
  await withTypeScriptHarness(async ({ client, uri }) => {
    const completions = await client.getCompletions({ textDocument: { uri }, position: { line: 5, character: 20 } });
    assert.ok(Array.isArray(completions.items));
    assert.ok(completions.items.length > 0);
  });
});

test('TypeScript adapter provides hover information', async () => {
  await withTypeScriptHarness(async ({ client, uri }) => {
    const hover = await client.getHover({ textDocument: { uri }, position: { line: 0, character: 16 } });
    assert.ok(Array.isArray(hover.contents));
    assert.ok(hover.contents[0].includes('runDemo'));
  });
});

test('TypeScript adapter resolves definitions in the same document', async () => {
  await withTypeScriptHarness(async ({ client, uri }) => {
    const definition = await client.getDefinition({ textDocument: { uri }, position: { line: 5, character: 20 } });
    assert.equal(definition.uri, uri);
    assert.ok(definition.range);
  });
});

test('TypeScript adapter returns document symbols', async () => {
  await withTypeScriptHarness(async ({ client, uri }) => {
    const symbols = await client.getDocumentSymbols({ textDocument: { uri } });
    assert.ok(Array.isArray(symbols));
    assert.ok(symbols.some((symbol) => symbol.name === 'runDemo'));
  });
});

test('TypeScript adapter rename produces workspace edit that applies cleanly', async () => {
  await withTypeScriptHarness(async ({ client, uri }) => {
    const renameEdit = await client.renameSymbol({
      textDocument: { uri },
      position: { line: 0, character: 16 },
      newName: 'runExample',
    });

    assert.ok(renameEdit.changes[uri].length > 0);

    const applyResult = client.applyWorkspaceEdit(renameEdit);
    assert.equal(applyResult.applied, true);
  });
});
