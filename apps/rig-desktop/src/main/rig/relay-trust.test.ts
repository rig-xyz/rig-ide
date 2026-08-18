import { describe, expect, it } from 'vitest';
import { checkRelayTrust, KNOWN_RELAY_HOST } from './relay-trust';

// The env parameter is passed explicitly throughout (including `undefined` for
// "unset") so the tests never depend on the machine's real environment.

describe('checkRelayTrust', () => {
  describe('known relay host', () => {
    it('allows https to the known relay', () => {
      expect(checkRelayTrust(`https://${KNOWN_RELAY_HOST}`, undefined)).toEqual({ trusted: true });
    });

    it('allows https to the known relay regardless of path or case', () => {
      expect(checkRelayTrust(`https://${KNOWN_RELAY_HOST}/v1`, undefined)).toEqual({
        trusted: true,
      });
      expect(checkRelayTrust(`HTTPS://${KNOWN_RELAY_HOST.toUpperCase()}`, undefined)).toEqual({
        trusted: true,
      });
    });

    it('blocks plain http to the known relay host', () => {
      expect(checkRelayTrust(`http://${KNOWN_RELAY_HOST}`, undefined)).toEqual({
        trusted: false,
        host: KNOWN_RELAY_HOST,
      });
    });

    it('blocks lookalike subdomains and suffixes of the known host', () => {
      expect(checkRelayTrust(`https://evil.${KNOWN_RELAY_HOST}`, undefined).trusted).toBe(false);
      expect(checkRelayTrust(`https://${KNOWN_RELAY_HOST}.evil.example`, undefined).trusted).toBe(
        false
      );
    });
  });

  describe('untrusted hosts', () => {
    it('blocks an arbitrary https host and names it', () => {
      expect(checkRelayTrust('https://attacker.example', undefined)).toEqual({
        trusted: false,
        host: 'attacker.example',
      });
    });

    it('reports the port along with the host', () => {
      expect(checkRelayTrust('https://attacker.example:8443/path', undefined)).toEqual({
        trusted: false,
        host: 'attacker.example:8443',
      });
    });

    it('blocks a URL that does not parse', () => {
      expect(checkRelayTrust('not a url', undefined).trusted).toBe(false);
    });

    it('blocks non-loopback private addresses', () => {
      expect(checkRelayTrust('http://192.168.1.10:8080', undefined).trusted).toBe(false);
    });
  });

  describe('loopback', () => {
    it('allows any scheme and port on localhost', () => {
      expect(checkRelayTrust('http://localhost:8787', undefined)).toEqual({ trusted: true });
      expect(checkRelayTrust('https://localhost', undefined)).toEqual({ trusted: true });
    });

    it('allows 127.0.0.1 and [::1]', () => {
      expect(checkRelayTrust('http://127.0.0.1:3000', undefined)).toEqual({ trusted: true });
      expect(checkRelayTrust('http://[::1]:3000', undefined)).toEqual({ trusted: true });
    });

    it('does not treat localhost lookalikes as loopback', () => {
      expect(checkRelayTrust('http://localhost.evil.example', undefined).trusted).toBe(false);
    });
  });

  describe('RIG_RELAY_ALLOW_HOSTS override', () => {
    it('allows an https host on the list', () => {
      expect(checkRelayTrust('https://relay.corp.example', 'relay.corp.example')).toEqual({
        trusted: true,
      });
    });

    it('handles a comma-separated list with whitespace and case differences', () => {
      const env = ' other.example , Relay.Corp.Example ';
      expect(checkRelayTrust('https://relay.corp.example', env)).toEqual({ trusted: true });
      expect(checkRelayTrust('https://other.example', env)).toEqual({ trusted: true });
    });

    it('is https-only: a listed host over http is still blocked', () => {
      expect(checkRelayTrust('http://relay.corp.example', 'relay.corp.example')).toEqual({
        trusted: false,
        host: 'relay.corp.example',
      });
    });

    it('does not allow hosts absent from the list', () => {
      expect(checkRelayTrust('https://attacker.example', 'relay.corp.example').trusted).toBe(false);
    });

    it('treats an empty list as no override', () => {
      expect(checkRelayTrust('https://attacker.example', '').trusted).toBe(false);
      expect(checkRelayTrust('https://attacker.example', ' , ').trusted).toBe(false);
    });
  });
});
