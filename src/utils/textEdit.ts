import { DocumentChange, Range, TextEdit } from '../types';
import { PolyClientError } from '../errors';

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  if (!Array.isArray(edits)) {
    throw new PolyClientError('INVALID_EDIT', 'Text edits must be an array.');
  }
  let result = text;
  const sorted = [...edits].map(validateTextEdit).sort(compareRangeReverse);
  for (const edit of sorted) {
    const start = offsetAt(result, edit.range.start);
    const end = offsetAt(result, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

export function applyContentChange(text: string, change: DocumentChange): string {
  if (!change || typeof change !== 'object') {
    throw new PolyClientError('INVALID_CHANGE', 'Document change must be an object.');
  }
  if (typeof change.text !== 'string') {
    throw new PolyClientError('INVALID_CHANGE', 'Document change is missing text property.');
  }
  if (!change.range) {
    return change.text;
  }
  const start = offsetAt(text, change.range.start);
  const end = offsetAt(text, change.range.end);
  return text.slice(0, start) + change.text + text.slice(end);
}

function validateTextEdit(edit: TextEdit): TextEdit {
  if (!edit || typeof edit !== 'object') {
    throw new PolyClientError('INVALID_EDIT', 'Text edit must be an object.');
  }
  if (!edit.range || !edit.range.start || !edit.range.end) {
    throw new PolyClientError('INVALID_EDIT', 'Text edit range is missing.');
  }
  if (typeof edit.newText !== 'string') {
    throw new PolyClientError('INVALID_EDIT', 'Text edit newText must be a string.');
  }
  return edit;
}

function compareRangeReverse(a: TextEdit, b: TextEdit): number {
  return (
    b.range.start.line - a.range.start.line
  ) || (
    b.range.start.character - a.range.start.character
  );
}

function offsetAt(text: string, position: Range['start']): number {
  if (!position || typeof position.line !== 'number' || typeof position.character !== 'number') {
    throw new PolyClientError('INVALID_POSITION', 'Position must have numeric line and character.');
  }
  if (position.line < 0 || position.character < 0) {
    throw new PolyClientError('INVALID_POSITION', 'Position line and character must be non-negative.');
  }
  const lines = text.split('\n');
  if (position.line >= lines.length) {
    return text.length;
  }
  let offset = 0;
  for (let i = 0; i < position.line; i += 1) {
    offset += lines[i].length + 1;
  }
  const line = lines[position.line] ?? '';
  return offset + Math.min(position.character, line.length);
}
