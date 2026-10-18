/**
 * The longest agent name the server accepts (POST /api/agents, PATCH /api/agents/:id). The name
 * fields in the console use the same limit, so a name that fits the field is never refused.
 */
export const AGENT_NAME_MAX = 64;
