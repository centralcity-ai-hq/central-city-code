import { CopyButton } from '../components';

/** A docs code box: a header with the label and Copy, then the code. */
export function Code({ value, label }: { value: string; label: string }) {
  return (
    <div className="docs-code">
      <div className="docs-code-header">
        <span>{label}</span>
        <CopyButton value={value} label="Copy" describedAs={label} variant="quiet" />
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>{value}</code>
      </pre>
    </div>
  );
}
