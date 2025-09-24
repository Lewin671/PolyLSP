const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPolyClient,
  registerLanguage,
  unregisterLanguage,
  PolyClientError,
} = require('../src');

const URI = 'file:///project/example.ts';

function createMockAdapter(overrides = {}) {
  return {
    languageId: 'mock',
    handlers: {
      getCompletions: () => ({
        isIncomplete: false,
        items: [{ label: 'hello' }],
      }),
      getHover: () => ({ contents: ['hover'] }),
    },
    ...overrides,
  };
}

test('registerLanguage resolves adapters and routes requests', async () => {
  const client = createPolyClient({ workspaceFolders: ['./src'] });
  const adapter = createMockAdapter();
  const result = await registerLanguage(client, adapter);
  assert.equal(result, 'mock');

  const doc = client.openDocument({
    uri: URI,
    languageId: 'mock',
    text: 'console.log(1);',
    version: 1,
  });
  assert.equal(doc.uri, URI);

  const completions = client.getCompletions({ uri: URI, position: { line: 0, character: 5 } });
  assert.equal(completions.items[0].label, 'hello');

  const hover = client.getHover({ uri: URI, position: { line: 0, character: 3 } });
  assert.deepEqual(hover, { contents: ['hover'] });
  client.dispose();
});

test('updateDocument applies ranged edits and enforces version ordering', () => {
  const client = createPolyClient();
  registerLanguage(client, createMockAdapter());
  client.openDocument({
    uri: URI,
    languageId: 'mock',
    text: 'const value = 1;\nconsole.log(value);\n',
    version: 1,
  });

  const updated = client.updateDocument({
    uri: URI,
    version: 2,
    changes: [
      {
        text: 'count',
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
      {
        text: 'count',
        range: {
          start: { line: 1, character: 12 },
          end: { line: 1, character: 17 },
        },
      },
    ],
  });

  assert.equal(
    updated.text,
    'const count = 1;\nconsole.log(count);\n',
  );

  assert.throws(() => {
    client.updateDocument({ uri: URI, version: 3, changes: [] });
  }, (error) => error instanceof PolyClientError && error.code === 'INVALID_CHANGES');
  client.dispose();
});

test('diagnostics listeners receive payloads published by adapters', async () => {
  const client = createPolyClient();
  let publishDiagnostics;
  const adapter = createMockAdapter({
    languageId: 'diagnostic',
    initialize(context) {
      publishDiagnostics = context.publishDiagnostics;
    },
  });
  await registerLanguage(client, adapter);
  client.openDocument({ uri: URI, languageId: 'diagnostic', text: 'let x = 1;', version: 1 });

  const received = [];
  const sub = client.onDiagnostics(URI, (event) => {
    received.push(event);
  });

  publishDiagnostics(URI, [{ message: 'Issue' }]);
  assert.equal(received.length, 1);
  assert.equal(received[0].languageId, 'diagnostic');
  assert.equal(received[0].diagnostics[0].message, 'Issue');

  sub.unsubscribe();
  client.dispose();
});

test('applyWorkspaceEdit mutates open documents', () => {
  const client = createPolyClient();
  registerLanguage(client, createMockAdapter());
  client.openDocument({ uri: URI, languageId: 'mock', text: 'function add() {\n  return 1;\n}\n', version: 1 });

  const result = client.applyWorkspaceEdit({
    changes: {
      [URI]: [
        {
          range: {
            start: { line: 1, character: 9 },
            end: { line: 1, character: 10 },
          },
          newText: '2',
        },
      ],
    },
  });

  assert.equal(result.applied, true);

  const updated = client.updateDocument({
    uri: URI,
    version: 3,
    changes: [{ text: 'function add() {\n  return 2;\n}\n' }],
  });
  assert.equal(updated.text.includes('return 2'), true);
  client.dispose();
});

test('workspace events notify listeners', async () => {
  const client = createPolyClient();
  let emitWorkspaceEvent;
  await registerLanguage(client, {
    languageId: 'workspace',
    initialize(context) {
      emitWorkspaceEvent = context.emitWorkspaceEvent;
    },
  });

  const events = [];
  const subscription = client.onWorkspaceEvent('config', (event) => {
    events.push(event);
  });

  emitWorkspaceEvent('config', { foo: 'bar' });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.foo, 'bar');
  assert.equal(events[0].languageId, 'workspace');

  subscription.unsubscribe();
  client.dispose();
});

test('sendNotification delegates to adapters when available', async () => {
  const client = createPolyClient();
  const received = [];
  await registerLanguage(client, {
    languageId: 'notifier',
    handlers: {
      sendNotification(method, params) {
        received.push({ method, params });
      },
    },
  });

  client.openDocument({ uri: URI, languageId: 'notifier', text: '', version: 1 });
  client.sendNotification('custom', { uri: URI, payload: 1 });
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'custom');
  client.dispose();
});

test('unregisterLanguage disposes adapters', async () => {
  const client = createPolyClient();
  let disposed = false;
  await registerLanguage(client, {
    languageId: 'temp',
    dispose() {
      disposed = true;
    },
  });
  const removed = unregisterLanguage(client, 'temp');
  assert.equal(removed, true);
  assert.equal(disposed, true);
  client.dispose();
});

test('invalid inputs surface descriptive errors', () => {
  const client = createPolyClient();
  assert.throws(() => client.openDocument({ uri: URI, languageId: 'none' }), PolyClientError);
  client.dispose();
});
