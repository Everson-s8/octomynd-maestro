export type ApplicationCommandErrorCode = "validation" | "not_found" | "conflict";

export class ApplicationCommandError extends Error {
  readonly code: ApplicationCommandErrorCode;
  readonly details: string[];

  constructor(code: ApplicationCommandErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "ApplicationCommandError";
    this.code = code;
    this.details = details.length > 0 ? details : [message];
  }
}

export function validationError(message: string, details: string[] = [message]): ApplicationCommandError {
  return new ApplicationCommandError("validation", message, details);
}

export function notFoundError(message: string, details: string[] = [message]): ApplicationCommandError {
  return new ApplicationCommandError("not_found", message, details);
}

export function conflictError(message: string, details: string[] = [message]): ApplicationCommandError {
  return new ApplicationCommandError("conflict", message, details);
}
