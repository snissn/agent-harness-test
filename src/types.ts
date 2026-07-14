export interface Diagnostic {
  file: string;
  code: string;
  message: string;
  path?: string;
}

export class ValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((item) => `${item.file}: ${item.message}`).join("\n"));
  }
}
