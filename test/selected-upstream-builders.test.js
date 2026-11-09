import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { StashConfigBuilder } from '../src/builders/StashConfigBuilder.js';
import { InvalidConfigError } from '../src/services/errors.js';
import { createStableProviderName } from '../src/utils.js';

function makeBuilder(format, input, {
    baseConfig = null,
    customRules = [],
    groupByCountry = false,
    includeAutoSelect = true,
    dialerProxyRules = []
} = {}) {
    if (format === 'Stash') {
        return new StashConfigBuilder(input, 'minimal', customRules, baseConfig, 'zh-CN', 'Stash/1.0',
            groupByCountry, includeAutoSelect, '', dialerProxyRules);
    }
    return new ClashConfigBuilder(input, 'minimal', customRules, baseConfig, 'zh-CN', 'mihomo',
        groupByCountry, false, undefined, undefined, includeAutoSelect, '', dialerProxyRules);
}

async function buildConfig(format, input, options) {
    return yaml.load(await makeBuilder(format, input, options).build());
}

function ssProxy(name, port = 443) {
    return { name, type: 'ss', server: 'example.com', port, cipher: 'aes-128-gcm', password: 'secret' };
}

const groupNamed = (config, name) => config['proxy-groups'].find(group => group.name === name);
const providerNamesByUrl = (config) => Object.fromEntries(
    Object.entries(config['proxy-providers']).map(([name, provider]) => [provider.url, name])
);

function mockRemoteSubscription() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(yaml.dump({
        proxies: [ssProxy('香港节点01'), ssProxy('US-Node', 444)]
    }), { headers: { 'Content-Type': 'text/yaml' } })));
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['Clash', 'Stash'])('%s selected upstream builder fixes', (format) => {
    it.each([undefined, false])('preserves UDP intent from YAML input (%s)', async (udp) => {
        const proxies = [
            ssProxy('SS'),
            { name: 'VMess', type: 'vmess', uuid: '11111111-1111-4111-8111-111111111111', cipher: 'auto' },
            { name: 'VLESS', type: 'vless', uuid: '22222222-2222-4222-8222-222222222222', tls: true },
            { name: 'Trojan', type: 'trojan', password: 'secret', tls: true },
            { name: 'AnyTLS', type: 'anytls', password: 'secret' }
        ].map((proxy, index) => ({ server: 'example.com', port: 443 + index, ...proxy,
            ...(udp === undefined ? {} : { udp }) }));
        const config = await buildConfig(format, yaml.dump({ proxies }));

        expect(config.proxies).toHaveLength(proxies.length);
        for (const proxy of config.proxies) {
            expect(proxy.udp, proxy.name).toBe(udp ?? true);
        }
    });

    it('maps AnyTLS session fields from complete JSON input', async () => {
        const input = JSON.stringify({ outbounds: [{
            type: 'anytls', tag: 'AnyTLS', server: 'example.com', server_port: 443,
            password: 'secret', idle_session_check_interval: 30, idle_session_timeout: 120,
            min_idle_session: 0, tls: { enabled: true, server_name: 'tls.example.com' }
        }] });
        const config = await buildConfig(format, input);

        expect(config.proxies[0]).toMatchObject({
            name: 'AnyTLS', type: 'anytls', sni: 'tls.example.com', udp: true,
            'idle-session-check-interval': 30, 'idle-session-timeout': 120, 'min-idle-session': 0
        });
        expect(config.proxies[0]).not.toHaveProperty('idle_session_timeout');
    });

    it('renames exact collisions without treating partial names as duplicates', async () => {
        const input = yaml.dump({ proxies: [
            ssProxy('edge-hy2', 443), ssProxy('edge', 444), ssProxy('edge 2', 445),
            ssProxy('edge', 446), ssProxy('edge', 447)
        ] });
        const config = await buildConfig(format, input);

        expect(config.proxies.map(proxy => proxy.name)).toEqual([
            'edge-hy2', 'edge', 'edge 2', 'edge 3', 'edge 4'
        ]);
    });

    it('keeps provider names stable across input order and duplicate subscriptions', async () => {
        mockRemoteSubscription();
        const firstUrl = 'https://subscriptions.example.com/first';
        const secondUrl = 'https://subscriptions.example.com/second';
        const first = await buildConfig(format, `${firstUrl}\n${secondUrl}\n${firstUrl}`);
        const reversed = await buildConfig(format, `${secondUrl}\n${firstUrl}`);

        expect(Object.keys(first['proxy-providers'])).toHaveLength(2);
        expect(providerNamesByUrl(first)).toEqual(providerNamesByUrl(reversed));
        for (const config of [first, reversed]) {
            for (const group of config['proxy-groups']) {
                for (const name of group.use || []) {
                    expect(config['proxy-providers'][name], `${group.name}: ${name}`).toBeDefined();
                }
            }
        }
        if (format === 'Stash') {
            for (const provider of Object.values(first['proxy-providers'])) {
                expect(Object.keys(provider).sort()).toEqual(['interval', 'url']);
            }
        }
    });

    it('preserves a user provider whose name collides with an automatic provider', async () => {
        mockRemoteSubscription();
        const url = 'https://subscriptions.example.com/first';
        const reservedName = createStableProviderName(url);
        const existingProvider = { url: 'https://subscriptions.example.com/manual', interval: 7200 };
        const config = await buildConfig(format, url, { baseConfig: {
            proxies: [], 'proxy-groups': [], 'proxy-providers': { [reservedName]: existingProvider }
        } });
        const providers = config['proxy-providers'];
        const automaticName = providerNamesByUrl(config)[url];

        expect(providers[reservedName]).toEqual(existingProvider);
        expect(automaticName).toBeDefined();
        expect(automaticName).not.toBe(reservedName);
        expect(groupNamed(config, '🚀 节点选择').use).toEqual(expect.arrayContaining([reservedName, automaticName]));
    });

    it('builds country groups from remote provider members with distinct filters', async () => {
        mockRemoteSubscription();
        const config = await buildConfig(format, 'https://subscriptions.example.com/countries', { groupByCountry: true });
        const hk = groupNamed(config, '🇭🇰 Hong Kong');
        const us = groupNamed(config, '🇺🇸 United States');

        expect(config.proxies).toHaveLength(0);
        expect(hk.use).toEqual(Object.keys(config['proxy-providers']));
        expect(us.use).toEqual(hk.use);
        expect(groupNamed(config, '🚀 节点选择').proxies).toEqual(expect.arrayContaining([hk.name, us.name]));
        // The clients accept RE2 inline flags; JavaScript takes those flags separately.
        const hkFilter = new RegExp(hk.filter.replace(/^\(\?i\)/, ''), 'i');
        const usFilter = new RegExp(us.filter.replace(/^\(\?i\)/, ''), 'i');
        expect(hkFilter.test('香港节点01')).toBe(true);
        expect(hkFilter.test('US-Node')).toBe(false);
        expect(usFilter.test('US-Node')).toBe(true);
        expect(usFilter.test('香港节点01')).toBe(false);
        expect(usFilter.test('plus-node')).toBe(false);
    });

    it('keeps complete custom rule choices without including country groups', async () => {
        const input = yaml.dump({ proxies: [ssProxy('HK-Node'), ssProxy('US-Node', 444)] });
        const config = await buildConfig(format, input, {
            groupByCountry: true,
            customRules: [{ name: 'Work', domain_suffix: ['work.example.com'] }]
        });

        expect(groupNamed(config, 'Work').proxies).toEqual([
            '🚀 节点选择', '⚡ 自动选择', '🖐️ 手动切换', 'HK-Node', 'US-Node', 'DIRECT', 'REJECT'
        ]);
        expect(config.rules).toContain('DOMAIN-SUFFIX,work.example.com,Work');
    });

    it('omits automatic groups and references when there are no selectable sources', async () => {
        const config = await buildConfig(format, '');

        expect(groupNamed(config, '⚡ 自动选择')).toBeUndefined();
        expect(config['proxy-groups'].every(group => !(group.proxies || []).includes('⚡ 自动选择'))).toBe(true);
        expect(config['proxy-groups'].every(group => group.type === 'select')).toBe(true);
    });

    it.each(['url-test', 'fallback'])('rejects a %s group after invalid members are removed', async (type) => {
        const input = yaml.dump({
            proxies: [ssProxy('Available')],
            'proxy-groups': [{ name: 'Broken', type, proxies: ['Missing'] }]
        });
        const builder = makeBuilder(format, input);

        await expect(builder.build()).rejects.toBeInstanceOf(InvalidConfigError);
        await expect(makeBuilder(format, input).build()).rejects.toMatchObject({
            status: 400, message: expect.stringContaining('Broken')
        });
    });

    it('preserves per-node chains, user groups, and DNS overrides', async () => {
        const policy = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
        const input = yaml.dump({
            proxies: [ssProxy('HK-Entry'), ssProxy('US-Exit', 444)],
            'proxy-groups': [{ name: 'Relay', type: 'select', proxies: ['HK-Entry'], interval: 600 }],
            dns: { 'nameserver-policy': { 'work.example.com': policy } }
        });
        const config = await buildConfig(format, input, {
            dialerProxyRules: [{ proxyNames: ['US-Exit'], target: 'Relay' }]
        });

        expect(config.proxies.find(proxy => proxy.name === 'HK-Entry')).not.toHaveProperty('dialer-proxy');
        expect(config.proxies.find(proxy => proxy.name === 'US-Exit')['dialer-proxy']).toBe('Relay');
        expect(groupNamed(config, 'Relay')).toMatchObject({ proxies: ['HK-Entry'], interval: 600 });
        expect(config.dns['nameserver-policy']['work.example.com']).toEqual(format === 'Stash' ? policy[0] : policy);
    });
});
