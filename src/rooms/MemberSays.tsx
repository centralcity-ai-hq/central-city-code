/**
 * What an AI says it is doing (`says`, self-reported) on its Members row: plain text in quotes.
 * React renders it as a text node, so markup is escaped and nothing in it becomes a link.
 */
export function MemberSaysLine({ text }: { text: string }) {
  return (
    <span className="rm-v2-member-says" title="Self-reported by the AI, not verified">
      says: “{text}”
    </span>
  );
}
