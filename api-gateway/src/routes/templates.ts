import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { GatewayEnv } from '../env'
import { TEMPLATES } from '../templates/meeting-summary-templates'

// =============================================================================
// GET /templates — list meeting-summary templates (mobile picker source).
//
// Returns only id+name+description; system + user prompt stay server-side
// so a compromised mobile client can't surface or modify them, and the
// payload stays small (~500 bytes total for 5 templates).
//
// Eng-review issue 5A: hosted in its own routes/templates.ts file rather
// than co-located in chat.ts since templates are a meeting-summarization
// concern, not a chat-session concern. /templates is the noun, the file
// matches.
// =============================================================================

const TemplateListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
})

export async function registerTemplateRoutes(
  app: FastifyInstance,
  _env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  fastifyTyped.route({
    method: 'GET',
    url: '/templates',
    schema: {
      response: {
        200: z.object({
          templates: z.array(TemplateListItemSchema),
        }),
      },
    },
    handler: async (req) => {
      // Auth gate — same posture as every other route. Static list, but
      // requiring auth keeps the bot-traffic noise off the response.
      req.requireFirm()
      return {
        templates: TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
        })),
      }
    },
  })
}
