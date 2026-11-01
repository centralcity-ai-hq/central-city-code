/** True when the visible link text already names the destination host. */
export function textShowsHost(text: string, host: string): boolean {
  const shown = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
  const real = host.toLowerCase().replace(/^www\./, '');
  return shown === real || (/^[/?#:]/.test(shown.slice(real.length)) && shown.startsWith(real));
}
