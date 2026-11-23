// Outbound HTTPS through a TLS passthrough proxy (deploy/nginx/resend-egress.conf).
//
// In production api_public has no route to the internet. A provider call opens TCP to the egress
// proxy, but TLS is negotiated end to end with the real provider: SNI and the certificate check use
// the provider's hostname, so the proxy only relays encrypted bytes and cannot read the request.
import { request as httpsRequest } from 'node:https';

export interface EgressAddress {
  readonly host: string;
  readonly port: number;
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ADDRESS = new RegExp(`^(${HOST_LABEL}(?:\\.${HOST_LABEL})*):([0-9]{1,5})$`, 'i');

/** Parses `host:port` (a DNS name or service alias and a port). Anything else is refused (null). */
export function parseEgressAddress(value: string): EgressAddress | null {
  const match = ADDRESS.exec(value.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return Object.freeze({ host: match[1].toLowerCase(), port });
}

/**
 * POSTs `body` to `url` through the egress proxy and resolves with the HTTP status code. The response
 * body is discarded. Rejects on a network or TLS failure, including a certificate that does not
 * match `url`'s hostname, and when `signal` aborts.
 */
export function postThroughEgress(
  egress: EgressAddress,
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: string,
  signal: AbortSignal,
): Promise<number> {
  if (url.protocol !== 'https:') return Promise.reject(new Error('egress requires https'));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const request = httpsRequest({
      host: egress.host,
      port: egress.port,
      // TLS identity is the provider's, not the proxy's.
      servername: url.hostname,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: url.host, 'Content-Length': String(Buffer.byteLength(body)) },
      agent: false,
      signal,
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end(body);
  });
}
