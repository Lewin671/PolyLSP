const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPolyClient,
  registerLanguage,
  unregisterLanguage,
  PolyClientError,
} = require('../dist');

const URI = 'file:///project/example.ts';

function createMockAdapter(overrides = {}) {
  const { handlers: handlerOverrides = {}, ...rest } = overrides;
  return {
    languageId: 'mock',
    handlers: {
      getCompletions: () => ({
        isIncomplete: false,
        items: [{ label: 'hello' }],
      }),
      getHover: () => ({ contents: ['hover'] }),
      getDocumentSymbols: () => [],
      ...handlerOverrides,
    },
    ...rest,
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
  await client.dispose();
});

test('updateDocument applies ranged edits, enforces version ordering, and notifies adapters', async () => {
  const client = createPolyClient();
  const updates = [];
  const adapter = createMockAdapter({
    handlers: {
      getCompletions: () => ({ items: [] }),
      getHover: () => null,
      updateDocument: (payload) => {
        updates.push(payload);
      },
    },
  });
  await registerLanguage(client, adapter);
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

  assert.equal(updates.length, 1);
  assert.equal(updates[0].version, 2);
  assert.equal(updates[0].changes.length, 2);
  assert.equal(updates[0].text.includes('count'), true);

  const unchanged = client.updateDocument({ uri: URI, version: 3, changes: [] });
  assert.equal(unchanged.version, 3);
  assert.equal(unchanged.text.includes('count'), true);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].changes.length, 1);
  await client.dispose();
});

test('document operations queue until adapters finish initializing', async () => {
  const client = createPolyClient();
  const events = [];
  let releaseInitialization = () => {};
  const adapter = {
    languageId: 'queued',
    async initialize() {
      await new Promise((resolve) => { releaseInitialization = resolve; });
    },
    handlers: {
      openDocument(payload) {
        events.push({ type: 'open', payload });
      },
      updateDocument(payload) {
        events.push({ type: 'update', payload });
      },
    },
  };

  const registration = registerLanguage(client, adapter);
  client.openDocument({ uri: URI, languageId: 'queued', text: 'const value = 1;', version: 1 });
  client.updateDocument({ uri: URI, version: 2, changes: [{ text: 'const value = 1;' }] });
  releaseInitialization();
  await registration;

  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'open');
  assert.equal(events[1].type, 'update');
  await client.dispose();
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
  await client.dispose();
});

test('applyWorkspaceEdit mutates open documents and synchronizes with adapters', async () => {
  const client = createPolyClient();
  const updatePayloads = [];
  const base = createMockAdapter();
  await registerLanguage(client, {
    ...base,
    handlers: {
      ...base.handlers,
      updateDocument: (payload) => updatePayloads.push(payload),
    },
  });
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
  assert.equal(result.failureReason, undefined);
  assert.equal(updatePayloads.length, 1);
  assert.equal(updatePayloads[0].version, 2);
  assert.equal(updatePayloads[0].text.includes('return 2'), true);

  const updated = client.updateDocument({
    uri: URI,
    version: 3,
    changes: [{ text: 'function add() {\n  return 2;\n}\n' }],
  });
  assert.equal(updated.text.includes('return 2'), true);
  await client.dispose();
});

test('applyWorkspaceEdit supports documentChanges with text edits', async () => {
  const client = createPolyClient();
  const updates = [];
  const adapter = createMockAdapter({
    handlers: {
      updateDocument: (payload) => updates.push(payload),
    },
  });
  await registerLanguage(client, adapter);
  client.openDocument({
    uri: URI,
    languageId: 'mock',
    text: 'package main\n\nfunc add(a int, b int) int {\n  return a + b\n}\n',
    version: 1,
  });

  const edit = {
    documentChanges: [
      {
        textDocument: { uri: URI, version: 1 },
        edits: [
          {
            range: {
              start: { line: 3, character: 10 },
              end: { line: 3, character: 11 },
            },
            newText: 'b',
          },
        ],
      },
    ],
  };

  const result = client.applyWorkspaceEdit(edit);
  assert.equal(result.applied, true);
  assert.equal(result.failures.length, 0);
  assert.equal(updates.length > 0, true);
  assert.equal(updates[0].changes[0].text, 'b');

  await client.dispose();
});

test('applyWorkspaceEdit reports failure metadata', async () => {
  const client = createPolyClient();
  const adapter = createMockAdapter();
  await registerLanguage(client, adapter);
  client.openDocument({ uri: URI, languageId: 'mock', text: 'const x = 1;', version: 1 });

  const result = client.applyWorkspaceEdit({
    documentChanges: [
      {
        textDocument: { uri: 'file:///missing.ts', version: 1 },
        edits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: 'test',
          },
        ],
      },
    ],
  });

  assert.equal(result.applied, false);
  assert.equal(result.failures.length, 1);
  assert.notEqual(result.failureReason, undefined);
  assert.equal(typeof result.failedChange, 'number');

  await client.dispose();
});

test('LanguageRegistrationContext handles server requests via PolyClient', async () => {
  const client = createPolyClient();
  let handleServerRequest;
  await registerLanguage(client, {
    languageId: 'server',
    async initialize(context) {
      handleServerRequest = context.handleServerRequest;
    },
  });

  assert.equal(typeof handleServerRequest, 'function');

  client.openDocument({ uri: URI, languageId: 'server', text: 'let value = 1;', version: 1 });

  const applyResponse = await handleServerRequest('workspace/applyEdit', {
    edit: {
      changes: {
        [URI]: [
          {
            range: {
              start: { line: 0, character: 11 },
              end: { line: 0, character: 12 },
            },
            newText: '2',
          },
        ],
      },
    },
  });

  assert.equal(applyResponse.applied, true);

  const configResponse = await handleServerRequest('workspace/configuration', {
    items: [{ section: 'test' }],
  });
  assert.equal(Array.isArray(configResponse), true);
  assert.equal(configResponse.length, 1);

  await client.dispose();
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
  await client.dispose();
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
  await client.dispose();
});

test('onError listeners receive adapter failures', async () => {
  const client = createPolyClient();
  const events = [];
  client.onError((event) => events.push(event));

  await registerLanguage(client, {
    languageId: 'faulty',
    handlers: {
      updateDocument() {
        throw new Error('boom');
      },
    },
  });

  client.openDocument({ uri: URI, languageId: 'faulty', text: 'const x = 1;', version: 1 });
  client.updateDocument({ uri: URI, version: 2, changes: [{ text: 'const x = 2;' }] });

  assert.equal(events.length, 1);
  assert.equal(events[0].languageId, 'faulty');
  assert.equal(events[0].operation, 'updateDocument');
  await client.dispose();
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
  await client.dispose();
});

test('invalid inputs surface descriptive errors', async () => {
  const client = createPolyClient();
  assert.throws(() => client.openDocument({ uri: URI, languageId: 'none' }), PolyClientError);
  await client.dispose();
});

test('resolveLanguageFromParams falls back to sole registered language', async () => {
  const client = createPolyClient();
  await registerLanguage(client, createMockAdapter());
  client.openDocument({ uri: URI, languageId: 'mock', text: 'console.log(1);', version: 1 });

  const result = client.getDocumentSymbols({ query: 'anything' });
  assert.equal(Array.isArray(result), true);
  await client.dispose();
});

test('requests without language context fail when ambiguous', async () => {
  const client = createPolyClient();
  await registerLanguage(client, createMockAdapter({ languageId: 'one' }));
  await registerLanguage(client, createMockAdapter({ languageId: 'two' }));

  assert.throws(() => client.sendRequest('ping', {}), (error) => {
    return error instanceof PolyClientError && error.code === 'LANGUAGE_NOT_RESOLVED';
  });

  await client.dispose();
});
