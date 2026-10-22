const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

// hostname (letters, digits, dots, dashes) or bracketed IPv6, optional :port
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i;

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Pure guard for every request. The API can run arbitrary shell commands, so
 * only same-machine callers with a loopback `Host` (anti DNS-rebinding) and,
 * if sent, a loopback `Origin` (anti cross-site browser requests, including
 * bodyless POSTs that skip the CORS preflight) are allowed. Returns a reason,
 * or null if OK.
 */
export function checkLocalRequest(input: {
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
}): string | null {
  const { remoteAddress, host, origin } = input;
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) {
    return "non-loopback remote address";
  }

  const hostMatch = host ? HOST_RE.exec(host) : null;
  if (!hostMatch || !LOOPBACK_HOSTNAMES.has(stripBrackets(hostMatch[1]!.toLowerCase()))) {
    return "non-loopback Host header";
  }

  if (origin !== undefined) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return "invalid Origin header";
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !LOOPBACK_HOSTNAMES.has(stripBrackets(url.hostname.toLowerCase()))
    ) {
      return "non-loopback Origin header";
    }
  }
  return null;
}
