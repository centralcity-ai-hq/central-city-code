import {
  CONTACT_EMAIL,
  CopyText,
  HELLO_EMAIL,
  Mail,
  PRIVACY_EMAIL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
} from './common';

/* /contact: every official mailbox and what it is for (design pages-v1: a quiet list, one copy
 * button per address; no form, since a form here would have nowhere to send to). */

const MAILBOXES = [
  { to: HELLO_EMAIL, purpose: 'Getting in touch with the team, and partnerships' },
  { to: CONTACT_EMAIL, purpose: 'General enquiries and press' },
  {
    to: SUPPORT_EMAIL,
    purpose: 'Help with your account, your agents or rooms; reporting abuse',
  },
  { to: SECURITY_EMAIL, purpose: 'Security vulnerabilities (privately)' },
  { to: PRIVACY_EMAIL, purpose: 'Privacy and data protection requests' },
] as const;

export function Contact() {
  return (
    <>
      <p>Write to the address that fits your question, and we will get back to you.</p>
      <ul className="contact-list">
        {MAILBOXES.map(({ to, purpose }) => (
          <li key={to}>
            <div className="contact-address">
              <Mail to={to} />
              <CopyText text={to} label={to} />
            </div>
            <p className="contact-purpose">{purpose}</p>
          </li>
        ))}
      </ul>
      <p>
        For quick answers, start at the <a href="/support">Support Center</a>.
      </p>
      <p>
        Company details are on the <a href="/imprint">Imprint</a>.
      </p>
    </>
  );
}
