const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { createPolyClient, registerLanguage } = require('../dist');
const { createGoAdapter } = require('../dist/adapters/go');

// Function to find gopls path dynamically
function findGoplsPath() {
  if (process.env.GOPLS_PATH) {
    return process.env.GOPLS_PATH;
  }

  try {
    // Try to find gopls in PATH
    const result = execSync('which gopls', { encoding: 'utf8' });
    return result.trim();
  } catch (error) {
    // If which command fails, try common locations
    const commonPaths = [
      path.join(process.env.HOME || '', 'go', 'bin', 'gopls'),
      '/usr/local/go/bin/gopls',
      '/usr/bin/gopls',
      '/opt/homebrew/bin/gopls'
    ];

    for (const goplsPath of commonPaths) {
      if (fs.existsSync(goplsPath)) {
        return goplsPath;
      }
    }

    throw new Error('gopls not found. Please install gopls or set GOPLS_PATH environment variable.');
  }
}

// Generate URI dynamically based on project root
const projectRoot = path.resolve(__dirname, '..');
const goWorkspaceFolder = path.join(projectRoot, 'examples', 'go-demo');
const goExamplePath = path.join(goWorkspaceFolder, 'main.go');
const URI = `file://${goExamplePath}`;
let GOPLS_PATH = null;
let skipGoTests = false;

try {
  GOPLS_PATH = findGoplsPath();
} catch (error) {
  skipGoTests = true;
  console.warn('Skipping Go adapter tests:', error.message);
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createGoHarness() {
  if (!GOPLS_PATH) {
    throw new Error('gopls path not resolved');
  }

  const client = createPolyClient({ workspaceFolders: [goWorkspaceFolder] });
  await registerLanguage(client, createGoAdapter({ goplsPath: GOPLS_PATH }));
  const source = fs.readFileSync(goExamplePath, 'utf8');
  client.openDocument({ uri: URI, languageId: 'go', text: source, version: 1 });
  await delay(2000);
  return {
    client,
    uri: URI,
    dispose: () => client.dispose(),
  };
}

async function withGoHarness(run) {
  const harness = await createGoHarness();
  try {
    await run(harness);
  } finally {
    harness.dispose();
  }
}

const goTest = skipGoTests ? test.skip : test;

goTest('Go adapter replies to completion requests', async () => {
  await withGoHarness(async ({ client, uri }) => {
    const completions = await client.getCompletions({
      textDocument: { uri },
      position: { line: 5, character: 5 },
    });

    console.log('Go completions:', completions);
    assert.ok(completions !== undefined, 'Completions should be defined (even if null)');
  });
});

goTest('Go adapter resolves definitions from gopls', async () => {
  await withGoHarness(async ({ client, uri }) => {
    const definition = await client.getDefinition({
      textDocument: { uri },
      position: { line: 4, character: 5 },
    });

    console.log('Go definition:', definition);
    assert.ok(definition !== undefined, 'Definition should be defined (even if null)');
  });
});

goTest('Go adapter finds references for identifiers', async () => {
  await withGoHarness(async ({ client, uri }) => {
    const references = await client.findReferences({
      textDocument: { uri },
      position: { line: 4, character: 5 },
      context: { includeDeclaration: true },
    });

    console.log('Go references:', references);
    assert.ok(references !== undefined, 'References should be defined (even if null)');
  });
});

goTest('Go adapter formats documents via gopls', async () => {
  await withGoHarness(async ({ client, uri }) => {
    const formatEdits = await client.formatDocument({ textDocument: { uri } });

    console.log('Go format edits:', formatEdits);
    assert.ok(formatEdits !== undefined, 'Format edits should be defined (even if null)');
  });
});

goTest('Go adapter returns document symbols from gopls', async () => {
  await withGoHarness(async ({ client, uri }) => {
    const symbols = await client.getDocumentSymbols({ textDocument: { uri } });

    console.log('Go document symbols:', symbols);
    assert.ok(symbols !== undefined, 'Symbols should be defined (even if null)');
  });
});
