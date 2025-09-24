import { PolyClientError } from '../errors';

export function normalizeUri(uri: string | undefined | null): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new PolyClientError('INVALID_URI', 'Document uri must be a non-empty string.');
  }
  return uri;
}
