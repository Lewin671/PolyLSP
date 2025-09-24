import { TextDocument } from '../types';

export function cloneValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // fall back to JSON clone when structuredClone fails
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function cloneDocument(doc: TextDocument | null | undefined): TextDocument | null {
  if (!doc) return null;
  return {
    uri: doc.uri,
    languageId: doc.languageId,
    text: doc.text,
    version: doc.version,
    openedAt: new Date(doc.openedAt.getTime()),
  };
}
