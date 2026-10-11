import { z } from 'zod';

/** A newsletter address (server-side validation; the form uses type=email). */
export const newsletterEmailSchema = z.string().trim().toLowerCase().max(254).email();
