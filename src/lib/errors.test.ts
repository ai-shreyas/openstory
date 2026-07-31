import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ConnectionError,
  DatabaseError,
  errorMessage,
  handleApiError,
  InsufficientCreditsError,
  isInsufficientCreditsError,
  StorageError,
  ValidationError,
  OpenStoryError,
} from './errors';

describe('OpenStoryError', () => {
  it('should create an error with all properties', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE', 400, {
      extra: 'data',
    });

    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ extra: 'data' });
    expect(error.name).toBe('OpenStoryError');
  });

  it('should use default status code of 500', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE');
    expect(error.statusCode).toBe(500);
  });

  it('should serialize to JSON correctly', () => {
    const error = new OpenStoryError('Test error', 'TEST_CODE', 400, {
      extra: 'data',
    });

    const json = error.toJSON();
    expect(json).toEqual({
      name: 'OpenStoryError',
      message: 'Test error',
      code: 'TEST_CODE',
      statusCode: 400,
      details: { extra: 'data' },
    });
  });
});

describe('Custom Error Classes', () => {
  describe('DatabaseError', () => {
    it('should create a database error with 500 status', () => {
      const error = new DatabaseError('Database connection failed', {
        table: 'users',
      });

      expect(error.message).toBe('Database connection failed');
      expect(error.code).toBe('DATABASE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ table: 'users' });
      expect(error.name).toBe('DatabaseError');
    });
  });

  describe('ConnectionError', () => {
    it('should create a connection error with 503 status', () => {
      const error = new ConnectionError('Service unavailable', {
        service: 'some-service',
      });

      expect(error.message).toBe('Service unavailable');
      expect(error.code).toBe('CONNECTION_ERROR');
      expect(error.statusCode).toBe(503);
      expect(error.details).toEqual({ service: 'some-service' });
      expect(error.name).toBe('ConnectionError');
    });
  });

  describe('ValidationError', () => {
    it('should create a validation error with 400 status', () => {
      const error = new ValidationError('Invalid input', {
        field: 'email',
      });

      expect(error.message).toBe('Invalid input');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({ field: 'email' });
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('ConfigurationError', () => {
    it('should create a configuration error with 500 status', () => {
      const error = new ConfigurationError('Missing environment variable', {
        variable: 'POSTGRES_URL',
      });

      expect(error.message).toBe('Missing environment variable');
      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ variable: 'POSTGRES_URL' });
      expect(error.name).toBe('ConfigurationError');
    });
  });

  describe('StorageError', () => {
    it('should create a storage error with 500 status', () => {
      const error = new StorageError('Failed to upload file', {
        bucket: 'images',
      });

      expect(error.message).toBe('Failed to upload file');
      expect(error.code).toBe('STORAGE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.details).toEqual({ bucket: 'images' });
      expect(error.name).toBe('StorageError');
    });
  });
});

describe('handleApiError', () => {
  it('should return OpenStoryError instance as is', () => {
    const openStoryError = new DatabaseError('Test error');
    const result = handleApiError(openStoryError);
    expect(result).toBe(openStoryError);
  });

  it('should convert standard Error to OpenStoryError', () => {
    const standardError = new Error('Standard error');
    const result = handleApiError(standardError);

    expect(result).toBeInstanceOf(OpenStoryError);
    expect(result.message).toBe('Standard error');
    expect(result.code).toBe('INTERNAL_ERROR');
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: 'Error' });
  });

  it('should handle unknown error types', () => {
    const unknownError = { weird: 'object' };
    const result = handleApiError(unknownError);

    expect(result).toBeInstanceOf(OpenStoryError);
    expect(result.message).toBe('An unknown error occurred');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.statusCode).toBe(500);
    expect(result.details).toEqual({ originalError: 'object' });
  });

  it('should handle null and undefined errors', () => {
    const nullResult = handleApiError(null);
    expect(nullResult.message).toBe('An unknown error occurred');
    expect(nullResult.details).toEqual({ originalError: 'object' });

    const undefinedResult = handleApiError(undefined);
    expect(undefinedResult.message).toBe('An unknown error occurred');
    expect(undefinedResult.details).toEqual({ originalError: 'undefined' });
  });

  it('should handle string errors', () => {
    const result = handleApiError('String error');
    expect(result.message).toBe('An unknown error occurred');
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.details).toEqual({ originalError: 'string' });
  });
});

describe('isInsufficientCreditsError', () => {
  it('matches our error across the server-fn boundary but not a provider’s', () => {
    const ours = new InsufficientCreditsError('Insufficient credits for image');
    // Only the message survives the boundary, so re-throw as a plain Error.
    expect(isInsufficientCreditsError(new Error(ours.message))).toBe(true);

    // OpenRouter's own balance — pinned in llm-client.test.ts. Routing this to
    // our billing dialog sends the user to top up an account that is fine.
    expect(
      isInsufficientCreditsError(
        new Error(
          'Insufficient credits. Add more using https://openrouter.ai/settings/credits'
        )
      )
    ).toBe(false);
  });

  it('keeps the wire marker out of displayed text', () => {
    const ours = new InsufficientCreditsError('Insufficient credits for image');
    expect(errorMessage(new Error(ours.message))).toBe(
      'Insufficient credits for image'
    );
  });
});
