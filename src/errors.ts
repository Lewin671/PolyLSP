export class PolyClientError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolyClientError';
    this.code = code;
  }
}
