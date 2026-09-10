export class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}

export function asHarnessError(error, code = 'E_INTERNAL') {
  if (error instanceof HarnessError) return error;
  return new HarnessError(code, 'Unexpected harness failure.', { cause: String(error?.message ?? error) });
}
