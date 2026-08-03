import { createStart } from '@tanstack/react-start';
import { loggerMiddleware } from '@/functions/middleware';
import { openStoryErrorSerializationAdapter } from '@/lib/errors';

export const startInstance = createStart(() => ({
  functionMiddleware: [loggerMiddleware],
  serializationAdapters: [openStoryErrorSerializationAdapter],
}));
