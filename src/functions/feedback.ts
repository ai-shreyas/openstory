/**
 * In-app feedback — sidebar dialog posts here, we email CONTACT_EMAIL.
 */

import { ValidationError } from '@/lib/errors';
import { CONTACT_EMAIL } from '@/lib/marketing/constants';
import { captureProductEvent } from '@/lib/observability/product-events';
import { sendFeedbackEmail } from '@/lib/services/email-service';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const feedbackInputSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Write a short message')
    .max(2000, 'Keep it under 2000 characters'),
});

export const submitFeedbackFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(feedbackInputSchema))
  .handler(async ({ data, context }) => {
    const result = await sendFeedbackEmail({
      to: CONTACT_EMAIL,
      userName: context.user.name,
      userEmail: context.user.email,
      teamId: context.teamId,
      message: data.message,
    });

    captureProductEvent({
      distinctId: context.user.id,
      event: 'feedback_submitted',
      properties: {
        teamId: context.teamId,
        userEmail: context.user.email,
        emailSent: result.success,
        messageLength: data.message.length,
      },
    });

    if (!result.success) {
      throw new ValidationError(
        `Couldn't send feedback — email ${CONTACT_EMAIL} directly.`
      );
    }

    return { success: true };
  });
