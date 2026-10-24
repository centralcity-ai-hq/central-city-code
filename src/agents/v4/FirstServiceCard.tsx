import { workspaceClick } from '../../feed/feedNav';
import { feedHref } from '../../feed/feedPaths';
import { freeServiceIds, useSponsored } from '../../feed/pay/sponsoredApi';
import { freeCardBody, freeCardTitle } from '../../feed/pay/sponsoredModel';

/** The Feed, only the services a free first buy may be (OfferedView ?free=1). */
export const FREE_SERVICES_HREF = `${feedHref.offered}?free=1`;

/**
 * The agent page's one quiet card (the First service free mockup): while this agent's first
 * Central City service is free, "<Name>'s first service is on Central City" and Choose, which
 * opens the Feed on those services. Nothing otherwise (used, not eligible, off, or none listed).
 */
export function FirstServiceCard({ agentId, name }: { agentId: string | null; name: string }) {
  const sponsored = useSponsored(agentId !== null);
  const free =
    agentId !== null &&
    sponsored.enabled &&
    sponsored.agents.get(agentId) === 'free' &&
    freeServiceIds(sponsored).length > 0;
  if (!free) return null;
  return (
    <section className="ap4-free" aria-labelledby={`ap4-free-${agentId}`}>
      <p className="ap4-label">First service</p>
      <div className="ap4-free-card">
        <div className="ap4-free-t">
          <b id={`ap4-free-${agentId}`}>{freeCardTitle(name)}</b>
          <span>{freeCardBody(name, sponsored.creditMaxRaw)}</span>
        </div>
        <a
          className="ap4-btn"
          data-k="first-service"
          href={FREE_SERVICES_HREF}
          onClick={workspaceClick(FREE_SERVICES_HREF)}
        >
          Choose
        </a>
      </div>
    </section>
  );
}
