export class RuntimeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
