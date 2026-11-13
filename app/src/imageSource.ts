// Hosts that only serve images to clients that identify themselves (native app only; browsers cannot send the header).
const HEADERS: Record<string, Record<string, string>> = {
  'www.artic.edu': { 'AIC-User-Agent': 'curi (research prototype)' },
};

export const imageSource = (uri: string) => {
  const host = /^https?:\/\/([^/]+)/.exec(uri)?.[1];
  const headers = host ? HEADERS[host] : undefined;
  return headers ? { uri, headers } : { uri };
};
