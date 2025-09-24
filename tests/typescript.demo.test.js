const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPolyClient, registerLanguage } = require('../dist');

// Generate URI dynamically based on project root
const projectRoot = path.resolve(__dirname, '..');
const tsWorkspaceFolder = path.join(projectRoot, 'examples', 'ts-demo');
const tsExamplePath = path.join(tsWorkspaceFolder, 'src', 'index.ts');
const URI = `file://${tsExamplePath}`;

// Simple test adapter that doesn't require external tools
function createTestTypeScriptAdapter() {
  return {
    languageId: 'typescript',
    handlers: {
      initialize: () => {
        // Adapter has no async setup
      },
      getCompletions: (params) => ({
        isIncomplete: false,
        items: [{ label: 'runDemo', kind: 3 }, { label: 'main', kind: 3 }],
      }),
      getHover: (params) => ({
        contents: ['runDemo: (name: string) => string'],
      }),
      getDefinition: (params) => ({
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } },
      }),
      findReferences: (params) => [
        { uri: params.textDocument.uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } } },
        { uri: params.textDocument.uri, range: { start: { line: 5, character: 20 }, end: { line: 5, character: 27 } } },
      ],
      formatDocument: () => [],
      getDocumentSymbols: () => [
        { name: 'runDemo', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } },
        { name: 'main', kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 9, character: 1 } } },
      ],
      renameSymbol: (params) => ({
        changes: {
          [params.textDocument.uri]: [
            { range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } }, newText: params.newName },
            { range: { start: { line: 5, character: 20 }, end: { line: 5, character: 27 } }, newText: params.newName },
          ],
        },
      }),
    },
  };
}

function createTypeScriptHarness() {
  const client = createPolyClient({ workspaceFolders: [tsWorkspaceFolder] });
  registerLanguage(client, createTestTypeScriptAdapter());
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
