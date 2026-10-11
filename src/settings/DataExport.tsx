import { useEffect, useRef, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileJson,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import { SettingsSectionHead } from './SettingsLayout';
import type { WorkspaceExport } from '../../shared/types';
import { api, ApiError, selectedWorkspaceId } from '../api';
import { PRIVACY_EMAIL } from '../trust/common';
import './account-data.css';

export interface DataExportProps {
  /** The selected workspace's operator ID, including a co-owned AI workspace. */
  operatorId: string;
}

export function DataExport({ operatorId }: DataExportProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setBusy(false);
    setError('');
    setDownloaded(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [operatorId]);

  async function download() {
    if (request.current) return;
    const controller = new AbortController();
    const workspace = selectedWorkspaceId();
    request.current = controller;
    const isCurrent = () =>
      request.current === controller &&
      !controller.signal.aborted &&
      selectedWorkspaceId() === workspace;
    setBusy(true);
    setError('');
    setDownloaded(false);
    try {
      const data = await api<WorkspaceExport>(
        '/api/workspace/export',
        undefined,
        'GET',
        controller.signal,
      );
      if (!isCurrent()) return;
      if (data.operator.id !== operatorId)
        throw new Error('Your workspace changed. Reload the page and try again.');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = `central-city-workspace-${data.exportedAt.slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDownloaded(true);
    } catch (err) {
      if (isCurrent())
        setError(
          err instanceof ApiError && err.status === 404
            ? "Export isn't available for this workspace."
            : err instanceof Error
              ? err.message
              : 'The export could not be downloaded.',
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section className="account-data" aria-label="Data & export">
      <SettingsSectionHead
        title="Data & export"
        lede="Download a machine-readable copy of this workspace’s records, in JSON format version 1."
      />
      <div className="account-data-card">
        <div className="account-data-heading">
          <span className="account-data-symbol" aria-hidden="true">
            <FileJson size={22} />
          </span>
          <div>
            <h3>Your workspace records</h3>
            <p>Download a private copy of the workspace you’re viewing.</p>
          </div>
        </div>
        <dl className="account-data-facts">
          <div>
            <dt>Included</dt>
            <dd>Agents, connections, exchanges and results, collaborations, and activity.</dd>
          </div>
          <div>
            <dt>History limits</dt>
            <dd>
              Up to 1,000 exchanges, 200 collaborations, and 1,000 activity events that are still
              retained.
            </dd>
          </div>
          <div>
            <dt>File format</dt>
            <dd>
              One JSON file, version 1. For your records; it can’t be imported back as a backup.
            </dd>
          </div>
        </dl>
        <div className="account-data-note">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            Authentication credentials are excluded. Text you or your agents supplied may still
            contain private information or secrets. Keep the file somewhere safe.
          </p>
        </div>
        <div className="account-data-actions">
          <button className="button primary" onClick={() => void download()} disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
            ) : (
              <Download size={16} aria-hidden="true" />
            )}
            {busy ? 'Preparing your file…' : 'Download workspace'}
          </button>
          <span className="account-data-muted">Downloading deletes nothing.</span>
        </div>
        <div role="status" aria-live="polite" className="account-data-status">
          {busy ? (
            'Preparing your file…'
          ) : downloaded ? (
            <>
              <CircleCheck size={16} aria-hidden="true" />
              Your download has started.
            </>
          ) : (
            ''
          )}
        </div>
        {error ? (
          <p className="account-data-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
      <div className="account-data-card">
        <h3>Messages and other data requests</h3>
        <p>
          Rooms and messages aren’t included in this file. For those records or an account deletion
          request, contact our privacy team from a channel we can verify.
        </p>
        <div className="account-data-actions">
          <a className="account-data-link" href={`mailto:${PRIVACY_EMAIL}`}>
            Contact privacy
          </a>
          <a className="account-data-link" href="/privacy">
            Privacy policy
          </a>
        </div>
      </div>
    </section>
  );
}
