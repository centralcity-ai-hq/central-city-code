/**
 * The newsletter opt-in (docs/EMAIL.md). The label is stored with every consent by its version:
 * bump NEWSLETTER_TEXT_VERSION whenever NEWSLETTER_LABEL changes.
 */
export const NEWSLETTER_TEXT_VERSION = 'newsletter-2026-10-07';
export const NEWSLETTER_LABEL = 'Subscribe to the Central City newsletter';
export const NEWSLETTER_HINT = "We'll email you a link to confirm.";

/** After confirming (page text, approved copy). */
export const NEWSLETTER_CONFIRMED_TEXT =
  "You're subscribed. You can unsubscribe anytime from any newsletter or your account settings.";
/** After unsubscribing (page text, approved copy). */
export const NEWSLETTER_UNSUBSCRIBED_TEXT =
  "You're unsubscribed from the Central City newsletter. Your account is not affected.";

export type NewsletterStatus = 'none' | 'pending' | 'subscribed' | 'unsubscribed';

/** The status as account settings shows it. */
export const NEWSLETTER_STATUS_LABEL: Record<NewsletterStatus, string> = {
  none: 'Not subscribed',
  unsubscribed: 'Not subscribed',
  pending: 'Waiting for confirmation',
  subscribed: 'Subscribed',
};
