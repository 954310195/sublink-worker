import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { createApp } from '../src/app/createApp.jsx';
import { MemoryKVAdapter } from '../src/adapters/kv/memoryKv.js';
import { parseProxyInput } from '../src/services/proxyInputService.js';

const providerUrl = 'https://subscriptions.example.com/nodes';
const remoteYaml = `
proxies:
  - name: HK-Node
    type: ss
    server: hk.example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
  - name: JP-Node
    type: ss
    server: jp.example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
`;

function createTestApp() {
    return createApp({
        kv: new MemoryKVAdapter(),
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
        config: { configTtlSeconds: 60, shortLinkTtlSeconds: null }
    });
}

function mockSubscription(body) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
}

afterEach(() => vi.restoreAllMocks());

describe('Selective upstream fixes with fork features', () => {
    it('collects remote provider names without turning provider nodes into inline proxies', async () => {
        const fetchSpy = mockSubscription(remoteYaml);
        const result = await parseProxyInput(providerUrl, {
            isCompatibleProviderFormat: format => format === 'clash'
        });

        expect(result.parsedItems).toEqual([]);
        expect(result.providerUrls).toEqual([providerUrl]);
        expect(result.providerNodeNames).toEqual(['HK-Node', 'JP-Node']);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each(['clash', 'stash'])('keeps %s country groups connected to their remote provider', async (format) => {
        mockSubscription(remoteYaml);
        const response = await createTestApp().request(
            `http://localhost/${format}?config=${encodeURIComponent(providerUrl)}&group_by_country=true`
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        const config = yaml.load(text);
        const providers = config['proxy-providers'];
        const providerName = Object.keys(providers).find(name => providers[name].url === providerUrl);
        expect(providerName).toBeDefined();

        for (const country of ['Hong Kong', 'Japan']) {
            const group = config['proxy-groups'].find(item => item.name.includes(country));
            expect(group).toBeDefined();
            expect(group.use).toContain(providerName);
            expect(group.filter).toBeTruthy();
        }
        for (const group of config['proxy-groups']) {
            for (const name of group.use || []) {
                expect(providers).toHaveProperty(name);
            }
        }
        if (format === 'stash') {
            expect(providers[providerName]).not.toHaveProperty('type');
            expect(config.dns['follow-rule']).toBe(false);
            expect(typeof config.dns['nameserver-policy']['geosite:cn,private']).toBe('string');
            expect(text.startsWith('#SUBSCRIBED ')).toBe(false);
        }
    });

    it.each(['clash', 'stash'])('preserves inspection and selected-node chains after %s name deduplication', async (format) => {
        const input = [
            'ss://YWVzLTEyOC1nY206c2VjcmV0@relay.example.com:443#edge-hy2',
            'ss://YWVzLTEyOC1nY206c2VjcmV0@exit.example.com:443#edge',
            'ss://YWVzLTEyOC1nY206c2VjcmV0@other.example.com:443#edge'
        ].join('\n');
        const app = createTestApp();
        const inspection = await app.request('http://localhost/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: input })
        });
        expect(inspection.status).toBe(200);
        const inspected = await inspection.json();
        expect(inspected.proxies.map(proxy => proxy.name)).toEqual(['edge-hy2', 'edge']);
        expect(inspected.targets).toContain('edge-hy2');

        const rules = JSON.stringify([{ proxyNames: ['edge'], target: 'edge-hy2' }]);
        const response = await app.request(
            `http://localhost/${format}?config=${encodeURIComponent(input)}&dialer_proxy_rules=${encodeURIComponent(rules)}`
        );
        expect(response.status).toBe(200);
        const config = yaml.load(await response.text());
        expect(config.proxies.map(proxy => proxy.name)).toEqual(['edge-hy2', 'edge', 'edge 2']);
        expect(config.proxies[0]).not.toHaveProperty('dialer-proxy');
        expect(config.proxies[1]['dialer-proxy']).toBe('edge-hy2');
        expect(config.proxies[2]['dialer-proxy']).toBe('edge-hy2');
    });

    it.each(['clash', 'stash'])('returns a useful 400 response for an empty %s test group', async (format) => {
        const input = `${remoteYaml}\nproxy-groups:\n  - name: Empty Test Group\n    type: url-test\n    proxies: []\n`;
        const response = await createTestApp().request(
            `http://localhost/${format}?config=${encodeURIComponent(input)}`
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('Invalid proxy group "Empty Test Group"');
    });
});
