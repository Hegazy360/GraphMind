/**
 * Egress guard (plan §3.6). Jack makes HTTP requests on behalf of AI
 * clients, so every request is checked twice:
 *
 *  1. **Origin:** the URL must be exactly the manifest's upstream origin.
 *     Tool arguments can never change the host, port or scheme.
 *  2. **Address:** under the `public` policy (the hosted default) the
 *     address actually connected to must be a public unicast address. The
 *     check runs inside the socket's DNS lookup, so the address that was
 *     checked is the address that is used — a DNS answer cannot pass the
 *     check and then rebind to 127.0.0.1 or 169.254.169.254.
 *
 * `any` allows private and loopback addresses. It exists for `jack preview`,
 * where an engineer points Jack at an API on their own machine.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export type EgressPolicy = 'public' | 'any';

export class EgressDeniedError extends Error {
  override name = 'EgressDeniedError';
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** IPv4 embedded in IPv6 (`::ffff:a.b.c.d`, `::ffff:7f00:1`, NAT64 `64:ff9b::a.b.c.d`). */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  for (const prefix of ['::ffff:', '64:ff9b::']) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (isIP(rest) === 4) return rest;
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (m) {
      const hi = Number.parseInt(m[1] as string, 16);
      const lo = Number.parseInt(m[2] as string, 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  return null;
}

/** True for any address that is not public unicast. Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4 !== null) return blocked.check(v4, 'ipv4');
    return blocked.check(bare, 'ipv6');
  }
  return true;
}

/**
 * Check the target URL against the allowed origin and, for IP literals,
 * the policy. (Hostnames are checked at connect time by `guardedLookup`;
 * Node skips DNS lookup entirely for IP literals.)
 */
export function checkTarget(url: URL, allowedOrigin: string, policy: EgressPolicy): void {
  if (url.origin !== new URL(allowedOrigin).origin) {
    throw new EgressDeniedError(`request to ${url.origin} is outside this project's upstream ${allowedOrigin}`);
  }
  if (url.username !== '' || url.password !== '') throw new EgressDeniedError('credentials in the upstream URL are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (policy === 'public' && isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new EgressDeniedError(`upstream address ${host} is not a public address`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for http.request that refuses private addresses under the `public` policy. */
export function guardedLookup(policy: EgressPolicy) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (policy === 'public') {
        // Strict: one private answer poisons the whole set, so round-robin
        // records cannot smuggle an internal address in alongside public ones.
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          const e = new EgressDeniedError(`${hostname} resolves to ${bad.address}, which is not a public address`) as NodeJS.ErrnoException;
          e.code = 'EJACKEGRESS';
          return callback(e, []);
        }
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }), []);
      callback(null, first.address, first.family);
    });
  };
}
