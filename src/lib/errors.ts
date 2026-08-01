/**
 * Custom error classes for better error handling and categorization.
 *
 * Server-fn boundary: TanStack Start serializes thrown errors with seroval,
 * which preserves own enumerable properties on `Error` instances. A thrown
 * `OpenStoryError` arrives on the client as a plain `Error` with the same
 * `name`/`message`/`code`/`statusCode`/`details` — so branch on `errorCode()`,
 * never on message prose. See #1087.
 */

export class OpenStoryError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

export class DatabaseError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', 500, details);
  }
}

export class ConnectionError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONNECTION_ERROR', 503, details);
  }
}

export class ValidationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

export class ConfigurationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', 500, details);
  }
}

export class StorageError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'STORAGE_ERROR', 500, details);
  }
}

export class AuthenticationError extends OpenStoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_ERROR', 401, details);
  }
}

export class NotFoundError extends OpenStoryError {
  constructor(
    message: string = 'Not found',
    details?: Record<string, unknown>
  ) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class InsufficientCreditsError extends OpenStoryError {
  constructor(
    message: string = 'Insufficient credits',
    details?: Record<string, unknown>
  ) {
    super(message, 'INSUFFICIENT_CREDITS', 402, details);
  }
}

/**
 * Stable machine-readable code from a thrown value.
 *
 * Works for live `OpenStoryError` instances on the server and for the plain
 * `Error` objects seroval reconstitutes on the client after a server-fn throw
 * (own props `code`/`statusCode`/`details` survive; the prototype does not).
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Is this OUR insufficient-credits failure? Callers gate the billing dialog on it. */
export function isInsufficientCreditsError(error: unknown): boolean {
  return errorCode(error) === 'INSUFFICIENT_CREDITS';
}

/** Display text for an arbitrary thrown value. */
export function errorMessage(
  error: unknown,
  fallback = 'Unknown error'
): string {
  if (!(error instanceof Error)) return fallback;
  return error.message;
}

/**
 * Utility function to handle and format errors consistently for API routes
 */
export const handleApiError = (error: unknown): OpenStoryError => {
  if (error instanceof OpenStoryError) {
    return error;
  }

  if (error instanceof Error) {
    return new OpenStoryError(error.message, 'INTERNAL_ERROR', 500, {
      originalError: error.name,
    });
  }

  return new OpenStoryError('An unknown error occurred', 'UNKNOWN_ERROR', 500, {
    originalError: typeof error,
  });
};
