import '../elric/elric-tokens.css';
import '../elric/elric-v3.css';
import { ManageElricSheet } from '../elric/ManageElricSheet';

/**
 * The Elric page's Manage Elric sheet, opened from Settings in Elric's pane in My agents. Its
 * styles are scoped to .elx3 (elric-v3.css), so it renders inside an .elx3 host; this module is
 * loaded on demand, so the Elric page's stylesheet stays out of the main bundle.
 */
export default function ManageElricHost(props: {
  onClose: () => void;
  onStatus: (status: 'active' | 'paused') => void;
}) {
  return (
    <div className="elx3 ma3-elric-host">
      <ManageElricSheet {...props} />
    </div>
  );
}
