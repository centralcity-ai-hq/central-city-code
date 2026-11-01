export async function loginCanary(
  { name, password, origin = 'https://centralcity.ai' },
  fetcher = fetch,
) {
  if (origin !== 'https://centralcity.ai')
    throw new Error('Password canary requires canonical production origin');
  if (
    typeof name !== 'string' ||
    !name.startsWith('canary-') ||
    typeof password !== 'string' ||
    !password
  )
    throw new Error('Missing dedicated canary login configuration');
  try {
    const response = await fetcher('https://centralcity.ai/api/auth/login', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        origin: 'https://centralcity.ai',
      },
      body: JSON.stringify({ name, password }),
    });
    if (!response.ok) throw new Error('HTTP');
    // Hosted sign-ins set __Host-cc_session; the plain name is what they set before the prefix.
    // The pair is sent back exactly as received.
    const pairs = response.headers.getSetCookie().map((value) => value.split(';')[0]);
    const cookie =
      pairs.find((value) => value.startsWith('__Host-cc_session=')) ??
      pairs.find((value) => value.startsWith('cc_session='));
    if (!cookie || cookie.endsWith('=')) throw new Error('Cookie');
    return cookie;
  } catch {
    throw new Error('Canary login failed');
  }
}
