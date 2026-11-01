import { ARC_EXPLORER_CHAIN as ARC, arcEnabled } from '../explorer/chain';
import { loadOnBase } from './onBaseData';

/*
 * /a/<short id> is every chain's passport link, and the passport page reads Base. A short id that
 * Base doesn't know may be an Arc agent's: its page is the Arc Explorer's agent page.
 */

/** The Arc agent page for this short id, or null when Arc is off or has no such agent. */
export async function arcPassportPage(
  short: string,
  deps: { on?: () => Promise<boolean>; read?: typeof loadOnBase } = {},
): Promise<string | null> {
  if (!(await (deps.on ?? arcEnabled)())) return null;
  const { rows } = await (deps.read ?? loadOnBase)({ q: short, listPath: ARC.paths.list });
  const row = rows.find((candidate) => candidate.short === short);
  return row ? ARC.agentPath(row.baseId) : null;
}
