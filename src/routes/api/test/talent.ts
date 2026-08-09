import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  cleanupTalentById,
  cleanupTalentByName,
  cleanupTestTalent,
  createTestTalent,
  createTestTalentWithMedia,
  getSystemTalentByName,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateTalentSchema = z.object({
  teamId: z.string(),
  name: z.string(),
  mediaCount: z.number().int().min(0).optional(),
});

const DeleteTalentSchema = z.object({
  teamId: z.string().optional(),
  talentId: z.string().optional(),
  name: z.string().optional(),
});

export const Route = createFileRoute('/api/test/talent')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        /**
         * POST /api/test/talent
         */
        POST: async ({ request }) => {
          const { teamId, name, mediaCount } = CreateTalentSchema.parse(
            await request.json()
          );

          if (!teamId || !name) {
            return Response.json(
              { error: 'teamId and name are required' },
              { status: 400 }
            );
          }

          const created =
            mediaCount && mediaCount > 0
              ? await createTestTalentWithMedia(teamId, name, mediaCount)
              : await createTestTalent(teamId, name);

          return Response.json(created);
        },

        /**
         * DELETE /api/test/talent
         * Supports: {teamId} (all for team), {talentId}, or {teamId, name}
         */
        DELETE: async ({ request }) => {
          const { teamId, talentId, name } = DeleteTalentSchema.parse(
            await request.json()
          );

          if (teamId && name) {
            await cleanupTalentByName(teamId, name);
          } else if (talentId) {
            await cleanupTalentById(talentId);
          } else if (teamId) {
            await cleanupTestTalent(teamId);
          } else {
            return Response.json(
              {
                error:
                  'teamId (for all) or talentId or (teamId + name) required',
              },
              { status: 400 }
            );
          }

          return Response.json({ success: true });
        },

        /**
         * GET /api/test/talent?name=...
         * Used for system (public) talent lookup by name (includes default sheet).
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get('name');
          if (!name) {
            return Response.json(
              { error: 'name query param required' },
              { status: 400 }
            );
          }
          try {
            const t = await getSystemTalentByName(name);
            return Response.json(t);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : 'not found' },
              { status: 404 }
            );
          }
        },
      }),
  },
});
