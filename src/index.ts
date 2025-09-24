import { PolyClient } from './core/polyClient';
import { ensureClient } from './utils/guards';
import type { LanguageAdapter, MaybePromise, PolyClientOptions } from './types';

export { PolyClient };
export type { NotificationListener } from './core/polyClient';
export { PolyClientError } from './errors';
export * from './types';

export function createPolyClient(options: PolyClientOptions = {}): PolyClient {
  return new PolyClient(options);
}

export function registerLanguage(client: PolyClient, adapter: LanguageAdapter): MaybePromise<string> {
  ensureClient(client);
  return client.registerLanguage(adapter);
}

export function unregisterLanguage(client: PolyClient, languageId: string): boolean {
  ensureClient(client);
  return client.unregisterLanguage(languageId);
}
