import yaml from 'js-yaml';
import { ClashConfigBuilder } from './ClashConfigBuilder.js';
import { STASH_CONFIG, generateRules, generateStashRuleSets } from '../config/index.js';
import { emitClashRules, sanitizeClashProxyGroups } from './helpers/clashConfigUtils.js';

function normalizeMbps(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    const match = trimmed.match(/^-?\d+(?:\.\d+)?/);
    if (!match) {
        return trimmed;
    }

    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : trimmed;
}

export class StashConfigBuilder extends ClashConfigBuilder {
    constructor(inputString, selectedRules, customRules, baseConfig, lang, userAgent, groupByCountry = false, includeAutoSelect = true) {
        super(
            inputString,
            selectedRules,
            customRules,
            baseConfig || STASH_CONFIG,
            lang,
            userAgent,
            groupByCountry,
            false,
            undefined,
            undefined,
            includeAutoSelect
        );
    }

    generateProxyProviders() {
        const providers = {};
        this.providerUrls.forEach((url, index) => {
            const name = `_auto_provider_${index + 1}`;
            providers[name] = {
                url,
                interval: 3600
            };
        });
        return providers;
    }

    convertProxy(proxy) {
        if (proxy?.type === 'hysteria2') {
            return {
                name: proxy.tag,
                type: 'hysteria2',
                server: proxy.server,
                port: proxy.server_port,
                ...(proxy.auth || proxy.password ? { auth: proxy.auth || proxy.password } : {}),
                ...(proxy.ports ? { ports: proxy.ports } : {}),
                ...(proxy.hop_interval !== undefined ? { 'hop-interval': proxy.hop_interval } : {}),
                ...(proxy.obfs?.type ? { obfs: proxy.obfs.type } : {}),
                ...(proxy.obfs?.password ? { 'obfs-password': proxy.obfs.password } : {}),
                ...(proxy.tls?.server_name ? { sni: proxy.tls.server_name } : {}),
                ...(proxy.tls?.insecure !== undefined ? { 'skip-cert-verify': !!proxy.tls.insecure } : {}),
                ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                ...(normalizeMbps(proxy.up) !== undefined ? { 'up-speed': normalizeMbps(proxy.up) } : {}),
                ...(normalizeMbps(proxy.down) !== undefined ? { 'down-speed': normalizeMbps(proxy.down) } : {})
            };
        }

        if (proxy?.type === 'tuic') {
            return {
                name: proxy.tag,
                type: 'tuic',
                server: proxy.server,
                port: proxy.server_port,
                version: 5,
                ...(proxy.uuid ? { uuid: proxy.uuid } : {}),
                ...(proxy.password ? { password: proxy.password } : {}),
                ...(proxy.congestion_control ? { 'congestion-controller': proxy.congestion_control } : {}),
                ...(proxy.tls?.insecure !== undefined ? { 'skip-cert-verify': !!proxy.tls.insecure } : {}),
                ...(proxy.disable_sni !== undefined ? { 'disable-sni': proxy.disable_sni } : {}),
                sni: proxy.tls?.server_name || '',
                alpn: Array.isArray(proxy.tls?.alpn) && proxy.tls.alpn.length > 0 ? proxy.tls.alpn : ['h3'],
                ...(proxy.udp_relay_mode ? { 'udp-relay-mode': proxy.udp_relay_mode } : {}),
                ...(proxy.zero_rtt !== undefined ? { 'zero-rtt': proxy.zero_rtt } : {}),
                ...(proxy.reduce_rtt !== undefined ? { 'reduce-rtt': proxy.reduce_rtt } : {}),
                ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {})
            };
        }

        return super.convertProxy(proxy);
    }

    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        const rules = this.generateRules();
        const { site_rule_providers, ip_rule_providers } = generateStashRuleSets(this.selectedRules, this.customRules, true);
        this.config['rule-providers'] = {
            ...site_rule_providers,
            ...ip_rule_providers
        };

        const ruleResults = emitClashRules(rules, this.t);

        if (this.providerUrls.length > 0) {
            this.config['proxy-providers'] = {
                ...this.config['proxy-providers'],
                ...this.generateProxyProviders()
            };
        }

        this.validateProxyGroups();
        sanitizeClashProxyGroups(this.config);

        this.config.rules = [
            ...ruleResults,
            `MATCH,${this.t('outboundNames.Fall Back')}`
        ];

        return yaml.dump(this.config);
    }
}
