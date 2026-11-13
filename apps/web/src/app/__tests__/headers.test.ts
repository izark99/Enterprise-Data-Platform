// Guards the security headers of 02-target-architecture.md §6.3 (apps/web/public/_headers).
import headersFile from '/public/_headers?raw';
import { describe, expect, it } from 'vitest';

const REQUIRED_HEADERS = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Strict-Transport-Security',
  'Cross-Origin-Opener-Policy',
];

// Cloudflare Pages format: a path line, then indented `Name: value` lines that apply to it.
const parseHeaders = (text: string): Map<string, Map<string, string>> => {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(':');
    if (current === undefined || colon === -1) throw new Error(`Bad _headers line: ${line}`);
    current.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return rules;
};

const parseCsp = (value: string): Map<string, string[]> =>
  new Map(
    value
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0] !== undefined && tokens[0] !== '')
      .map(([name = '', ...sources]) => [name, sources]),
  );

const allPaths = parseHeaders(headersFile).get('/*');
const csp = parseCsp(allPaths?.get('Content-Security-Policy') ?? '');

describe('_headers', () => {
  it('serves every header of 02 §6.3 for /*', () => {
    expect(allPaths).toBeDefined();
    for (const name of REQUIRED_HEADERS) expect(allPaths?.get(name), name).toBeTruthy();
  });

  it('connect-src names no host (only keywords and schemes until P3)', () => {
    const sources = csp.get('connect-src');
    expect(sources).toBeDefined();
    const hosts = (sources ?? []).filter(
      (s) => !s.startsWith("'") && !/^[a-z][a-z0-9+.-]*:$/.test(s),
    );
    expect(hosts).toEqual([]);
  });

  it("script-src allows neither 'unsafe-inline' nor 'unsafe-eval'", () => {
    const sources = csp.get('script-src');
    expect(sources).toBeDefined();
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
  });
});
