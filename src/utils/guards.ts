import { CLIENT_BRAND } from '../constants';
import { PolyClientError } from '../errors';
import type { PolyClient } from '../core/polyClient';

export function ensureClient(client: unknown): asserts client is PolyClient {
  if (!client || (client as Record<PropertyKey, unknown>)[CLIENT_BRAND] !== true) {
    throw new PolyClientError('INVALID_CLIENT', 'Provided value is not a PolyLSP client instance.');
  }
}
