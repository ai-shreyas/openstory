/**
 * Custom error classes for better error handling and categorization
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

/**
 * Stamped into the message because only the message survives the server-fn
 * boundary — `code` does not. The prose alone can't carry this: providers
 * throw "Insufficient credits…" about THEIR balance (OpenRouter's is pinned in
 * `llm-client.test.ts`), and routing that to our billing dialog sends the user
 * to top up an account that is already fine.
 */
const INSUFFICIENT_CREDITS_MARKER = '[INSUFFICIENT_CREDITS]';

export class InsufficientCreditsError extends OpenStoryError {
  constructor(
    message: string = 'Insufficient credits',
    details?: Record<string, unknown>
  ) {
    super(
      `${INSUFFICIENT_CREDITS_MARKER} ${message}`,
      'INSUFFICIENT_CREDITS',
      402,
      details
    );
  }
}

/** Is this OUR insufficient-credits failure? Callers gate the billing dialog on it. */
export function isInsufficientCreditsError(error: unknown): boolean {
  if (error instanceof InsufficientCreditsError) return true;
  return (
    error instanceof Error &&
    error.message.includes(INSUFFICIENT_CREDITS_MARKER)
  );
}

/** Display text for an arbitrary thrown value, minus any internal wire marker. */
export function errorMessage(
  error: unknown,
  fallback = 'Unknown error'
): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(INSUFFICIENT_CREDITS_MARKER, '').trim();
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
