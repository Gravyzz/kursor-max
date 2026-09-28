/** Заглушка SDK MAX: воркер импортирует из него только класс ошибки. */
export class MaxError extends Error {
  constructor(
    public readonly status: number,
    message = 'MAX API error',
  ) {
    super(message);
  }
}

export class Bot {}
export type Context = Record<string, unknown>;
