import path from 'path';
import { URL } from 'url';
import { PolyClientError } from '../errors';

const WINDOWS_DRIVE_REGEX = /^([a-zA-Z]):[\\/]/;

function ensureFileUriFromPath(input: string): string {
  const absolute = path.resolve(input);
  const normalizedPath = absolute.replace(/\\/g, '/');
  return `file://${normalizedPath.startsWith('/') ? '' : '/'}${encodeURI(normalizedPath)}`;
}

export function normalizeUri(uri: string | undefined | null): string {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw new PolyClientError('INVALID_URI', 'Document uri must be a non-empty string.');
  }

  const trimmed = uri.trim();

  try {
    if (WINDOWS_DRIVE_REGEX.test(trimmed)) {
      return ensureFileUriFromPath(trimmed);
    }

    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return ensureFileUriFromPath(trimmed);
    }

    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') {
      let pathname = parsed.pathname.replace(/\\/g, '/');
      const match = pathname.match(/^\/([a-zA-Z]):/);
      if (match) {
        pathname = `/${match[1].toUpperCase()}:${pathname.slice(3)}`;
      }
      parsed.pathname = pathname;
      parsed.hash = '';
    }
    return parsed.toString();
  } catch (error) {
    throw new PolyClientError('INVALID_URI', `Invalid document uri: ${trimmed}`);
  }
}
