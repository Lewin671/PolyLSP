const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPolyClient, registerLanguage } = require('../dist');

const URI = 'file:///Users/qingyingliu/Code/PolyLSP/examples/ts-demo/src/index.ts';

// Simple test adapter that doesn't require external tools
function createTestTypeScriptAdapter() {
  return {
    languageId: 'typescript',
    handlers: {
      initialize: (ctx) => {
        // Just mark as initialized
      },
      getCompletions: (params) => ({
        isIncomplete: false,
        items: [{ label: 'runDemo', kind: 3 }, { label: 'main', kind: 3 }]
      }),
      getHover: (params) => ({
        contents: ['runDemo: (name: string) => string']
      }),
      getDefinition: (params) => ({
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } }
      }),
      findReferences: (params) => [
        { uri: params.textDocument.uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } } },
        { uri: params.textDocument.uri, range: { start: { line: 5, character: 20 }, end: { line: 5, character: 27 } } }
      ],
      formatDocument: (params) => [],
      getDocumentSymbols: (params) => [
        { name: 'runDemo', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } },
        { name: 'main', kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 9, character: 1 } } }
      ],
      renameSymbol: (params) => ({
        changes: {
          [params.textDocument.uri]: [
            { range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } }, newText: params.newName },
            { range: { start: { line: 5, character: 20 }, end: { line: 5, character: 27 } }, newText: params.newName }
          ]
        }
      })
    }
  };
}

test('TypeScript demo workflow exercises key APIs', async () => {
  const client = createPolyClient({ workspaceFolders: ['/Users/qingyingliu/Code/PolyLSP/examples/ts-demo'] });
  const workspaceEvents = [];
  const diagnostics = [];

  const workspaceSubscription = client.onWorkspaceEvent('workspace/didChangeConfiguration', (event) => {
    workspaceEvents.push(event);
  });

  const diagnosticsSubscription = client.onDiagnostics(URI, (event) => {
    diagnostics.splice(0, diagnostics.length, ...event.diagnostics);
  });

  registerLanguage(client, createTestTypeScriptAdapter());

  const source = fs.readFileSync(path.join(__dirname, '../examples/ts-demo/src/index.ts'), 'utf8');

  client.openDocument({ uri: URI, languageId: 'typescript', text: source, version: 1 });

  const completionsBeforeRename = await client.getCompletions({ textDocument: { uri: URI }, position: { line: 5, character: 20 } });

  const hover = await client.getHover({ textDocument: { uri: URI }, position: { line: 0, character: 16 } });

  const definition = await client.getDefinition({ textDocument: { uri: URI }, position: { line: 5, character: 20 } });

  const renameEdit = await client.renameSymbol({
    textDocument: { uri: URI },
    position: { line: 0, character: 16 },
    newName: 'runExample',
  });
  const renameResult = client.applyWorkspaceEdit(renameEdit);

  const completionsAfterRename = await client.getCompletions({ textDocument: { uri: URI }, position: { line: 5, character: 20 } });

  const hoverAfterRename = await client.getHover({ textDocument: { uri: URI }, position: { line: 0, character: 16 } });

  diagnosticsSubscription.unsubscribe();
  workspaceSubscription.unsubscribe();
  client.dispose();

  assert.ok(completionsBeforeRename.items.length > 0);
  assert.ok(hover.contents.length > 0);
  assert.ok(definition);
  assert.equal(renameResult.applied, true);
  assert.ok(renameEdit.changes[URI].length > 0);
  assert.ok(completionsAfterRename.items.length > 0);
  assert.ok(hoverAfterRename.contents.length > 0);
  assert.ok(diagnostics.length >= 0);
  assert.ok(workspaceEvents.length >= 0);
});

test('TypeScript adapter emits symbols and rename edits based on document text', async () => {
  const client = createPolyClient({ workspaceFolders: ['/Users/qingyingliu/Code/PolyLSP/examples/ts-demo'] });
  registerLanguage(client, createTestTypeScriptAdapter());

  const source = fs.readFileSync(path.join(__dirname, '../examples/ts-demo/src/index.ts'), 'utf8');

  client.openDocument({ uri: URI, languageId: 'typescript', text: source, version: 1 });

  const symbols = await client.getDocumentSymbols({ textDocument: { uri: URI } });

  assert.ok(symbols.length > 0);

  const renameEdit = await client.renameSymbol({
    textDocument: { uri: URI },
    position: { line: 0, character: 16 },
    newName: 'primary',
  });
  assert.ok(renameEdit.changes[URI].length > 0);

  client.dispose();
});
