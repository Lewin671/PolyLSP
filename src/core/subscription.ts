import { Disposable } from '../types';

export class Subscription implements Disposable {
  public closed = false;

  private readonly unsubscribeFn?: () => void;

  constructor(unsubscribe?: () => void) {
    this.unsubscribeFn = unsubscribe;
  }

  unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.unsubscribeFn === 'function') {
      this.unsubscribeFn();
    }
  }
}
