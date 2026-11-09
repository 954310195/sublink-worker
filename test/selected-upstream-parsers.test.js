import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyParser } from '../src/parsers/ProxyParser.js';
import { convertYamlProxyToObject } from '../src/parsers/convertYamlProxyToObject.js';
import { fetchSubscription, fetchSubscriptionWithFormat } from '../src/parsers/subscription/httpSubscriptionFetcher.js';
import { encodeBase64 } from '../src/utils.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

function mockSubscription(content) {
    const fetchMock = vi.fn(async () => new Response(content, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('Selected upstream protocol parsing', () => {
    it('parses AnyTLS URI options without losing password escapes or explicit false values', async () => {
        const password = 'pass@word:%+#';
        const result = await ProxyParser.parse(
            `AnyTLS://${encodeURIComponent(password)}@example.com:8443?` +
            'sni=tls.example.com&insecure=false&alpn=h2,http%2F1.1&fp=chrome&udp=false' +
            '&idle-session-check-interval=30&idle-session-timeout=120&min-idle-session=0#AnyTLS%20Node'
        );

        expect(result).toMatchObject({
            tag: 'AnyTLS Node',
            type: 'anytls',
            server: 'example.com',
            server_port: 8443,
            password,
            udp: false,
            'idle-session-check-interval': 30,
            'idle-session-timeout': 120,
            'min-idle-session': 0,
            tls: {
                enabled: true,
                insecure: false,
                server_name: 'tls.example.com',
                alpn: ['h2', 'http/1.1'],
                utls: { enabled: true, fingerprint: 'chrome' }
            }
        });
    });

    it('supports AnyTLS IPv6, default port, and established option aliases', async () => {
        const result = await ProxyParser.parse(
            'anytls://secret@[2001:db8::1]?servername=tls.example.com&allowInsecure=1' +
            '&client-fingerprint=firefox&idle_session_timeout=60&min_idle_session=2' +
            '&idle_session_check_interval=invalid'
        );

        expect(result).toMatchObject({
            tag: 'AnyTLS [2001:db8::1]:443',
            server: '2001:db8::1',
            server_port: 443,
            'idle-session-timeout': 60,
            'min-idle-session': 2,
            tls: { insecure: true, server_name: 'tls.example.com', utls: { fingerprint: 'firefox' } }
        });
        expect(result).not.toHaveProperty('idle-session-check-interval');
        expect(result).not.toHaveProperty('udp');
    });

    it.each([
        ['mport=20000-20100,443&hop_interval=15', '20000-20100,443', 15],
        ['ports=30000-30100&hop-interval=20', '30000-30100', 20]
    ])('preserves Hysteria2 port hopping from URI query %s', async (query, ports, interval) => {
        const result = await ProxyParser.parse(`hy2://secret@hy2.example.com:443?${query}#HY2`);
        expect(result).toMatchObject({
            type: 'hysteria2', ports, hop_interval: interval, tls: { enabled: true }
        });
    });

    it('preserves Hysteria2 YAML mport and hop_interval aliases', () => {
        const result = convertYamlProxyToObject({
            name: 'HY2', type: 'hysteria2', server: 'hy2.example.com', port: 443,
            password: 'secret', mport: '20000-20100', hop_interval: '15'
        });
        expect(result).toMatchObject({ ports: '20000-20100', hop_interval: 15 });
    });

    it('enables Trojan TLS when security is omitted and retains the existing network field', async () => {
        const result = await ProxyParser.parse('trojan://secret@example.com:443?sni=tls.example.com#Trojan');
        expect(result).toMatchObject({
            type: 'trojan', network: 'tcp',
            tls: { enabled: true, server_name: 'tls.example.com' }
        });
    });

    it('respects an explicitly supplied Trojan security setting', async () => {
        const result = await ProxyParser.parse('trojan://secret@example.com:443?security=none#Trojan');
        expect(result.tls.enabled).toBe(false);
    });
});

describe('Remote subscription envelope decoding', () => {
    const yamlConfig = `proxies:
  - name: SS%20literal
    type: ss
    server: example.com
    port: 8388
    cipher: aes-256-gcm
    password: "pass+word/=%25"
`;

    it.each([
        ['plain YAML', value => value],
        ['Base64 YAML', value => encodeBase64(value)],
        ['URL-encoded YAML', value => encodeURIComponent(value)],
        ['URL-encoded Base64 YAML', value => encodeURIComponent(encodeBase64(value))],
        ['Base64 URL-encoded YAML', value => encodeBase64(encodeURIComponent(value))]
    ])('reads %s without decoding literal field values', async (_, encode) => {
        mockSubscription(encode(yamlConfig));
        const result = await fetchSubscription('https://subscription.example.com/config');
        expect(result).toMatchObject({
            type: 'yamlConfig',
            proxies: [{ tag: 'SS%20literal', password: 'pass+word/=%25' }]
        });
    });

    it.each([
        ['plain', value => value],
        ['Base64', value => encodeBase64(value)],
        ['URL-encoded', value => encodeURIComponent(value)],
        ['URL-safe Base64 without padding', value => encodeBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')],
        ['wrapped Base64', value => encodeBase64(value).match(/.{1,24}/g).join('\r\n')]
    ])('preserves SS and Trojan URI parameters in a %s subscription', async (_, encode) => {
        const ssPassword = '???~~~+/%25=#:tail';
        const ssUri = `ss://${encodeURIComponent(encodeBase64(`aes-256-gcm:${ssPassword}`))}@ss.example.com:8388#Encoded%2520Name%23suffix`;
        const trojanPassword = 'pass%word@x#?+';
        const wsPath = '/ws?ed=2048&token=one%two';
        const trojanUri = `trojan://${encodeURIComponent(trojanPassword)}@trojan.example.com:443?type=ws&path=${encodeURIComponent(wsPath)}#Trojan`;
        mockSubscription(encode(`${ssUri}\n${trojanUri}`));

        const lines = await fetchSubscription('https://subscription.example.com/nodes');
        expect(lines).toEqual([ssUri, trojanUri]);
        const [ss, trojan] = await Promise.all(lines.map(line => ProxyParser.parse(line)));
        expect(ss).toMatchObject({
            type: 'shadowsocks', method: 'aes-256-gcm', password: ssPassword,
            tag: 'Encoded%20Name#suffix', network: 'tcp'
        });
        expect(trojan).toMatchObject({
            password: trojanPassword, server: 'trojan.example.com',
            transport: { type: 'ws', path: wsPath }
        });
    });

    it('detects plain Surge input and forwards the requested User-Agent', async () => {
        const content = '[Proxy]\nSS = ss, example.com, 8388, encrypt-method=aes-256-gcm, password=secret';
        const fetchMock = mockSubscription(content);
        const result = await fetchSubscriptionWithFormat('https://subscription.example.com/surge', 'Clash/test');
        expect(result).toEqual({ content, format: 'surge', url: 'https://subscription.example.com/surge' });
        expect(fetchMock.mock.calls[0][1].headers.get('User-Agent')).toBe('Clash/test');
    });

    it('keeps already supported JSON input intact', async () => {
        const content = JSON.stringify({ outbounds: [{ type: 'shadowsocks', tag: 'literal%20tag' }] });
        mockSubscription(content);
        const result = await fetchSubscriptionWithFormat('https://subscription.example.com/json');
        expect(result).toMatchObject({ content, format: 'singbox' });
    });

    it('accepts Base64 AnyTLS subscriptions', async () => {
        const uri = 'anytls://secret@example.com:443?sni=tls.example.com#AnyTLS';
        mockSubscription(encodeBase64(uri));
        const lines = await fetchSubscription('https://subscription.example.com/anytls');
        expect(lines).toEqual([uri]);
        expect(await ProxyParser.parse(lines[0])).toMatchObject({ type: 'anytls', password: 'secret' });
    });

    it('does not turn an arbitrary Base64-looking response into corrupted text', async () => {
        mockSubscription('not-a-subscription');
        const result = await fetchSubscriptionWithFormat('https://subscription.example.com/invalid');
        expect(result).toMatchObject({ content: 'not-a-subscription', format: 'unknown' });
    });
});
