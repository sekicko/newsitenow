function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  let originUrl: URL;
  let requestUrl: URL;
  try {
    originUrl = new URL(origin);
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
  if (request.headers.get('sec-fetch-site') === 'same-origin') return true;

  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'));
  const host = forwardedHost ?? firstHeaderValue(request.headers.get('host')) ?? requestUrl.host;
  const forwardedProtocol = firstHeaderValue(request.headers.get('x-forwarded-proto'))?.toLowerCase();
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
    ? `${forwardedProtocol}:`
    : requestUrl.protocol;

  try {
    const publicOrigin = new URL(`${protocol}//${host}`).origin;
    return originUrl.origin === publicOrigin || originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}
