import { ProxyParser } from '../parsers/index.js';
import { createTranslator } from '../i18n/index.js';
import { getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';
import { groupProxiesByCountry } from '../utils.js';
import { tryDecodeSubscriptionLines, decodeBase64 } from '../utils.js';

function collectParsedConfig(result, parsedItems, configOverrides) {
    if (!result || typeof result !== 'object') {
        return false;
    }

    if (result.config) {
        configOverrides.push(result.config);
    }

    if (Array.isArray(result.proxies)) {
        for (const proxy of result.proxies) {
            if (proxy && proxy.tag) {
                parsedItems.push(proxy);
            }
        }
        return result.proxies.length > 0;
    }

    return false;
}

export async function parseProxyInput(inputString, {
    userAgent,
    isCompatibleProviderFormat = () => false
} = {}) {
    const input = inputString || '';
    const parsedItems = [];
    const providerUrls = [];
    const configOverrides = [];

    const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');

    const directResult = parseSubscriptionContent(input);
    if (collectParsedConfig(directResult, parsedItems, configOverrides) && parsedItems.length > 0) {
        return { parsedItems, providerUrls, configOverrides };
    }

    const isBase64Like = /^[A-Za-z0-9+/=\r\n]+$/.test(input) && input.replace(/[\r\n]/g, '').length % 4 === 0;
    if (isBase64Like) {
        try {
            const sanitized = input.replace(/\s+/g, '');
            const decodedWhole = decodeBase64(sanitized);
            if (typeof decodedWhole === 'string') {
                const decodedResult = parseSubscriptionContent(decodedWhole);
                if (collectParsedConfig(decodedResult, parsedItems, configOverrides) && parsedItems.length > 0) {
                    return { parsedItems, providerUrls, configOverrides };
                }
            }
        } catch (_) {
            // Ignore invalid base64 input and continue with line parsing.
        }
    }

    const urls = input.split('\n').filter((url) => url.trim() !== '');
    for (const url of urls) {
        let processedUrls = tryDecodeSubscriptionLines(url);
        if (!Array.isArray(processedUrls)) {
            processedUrls = [processedUrls];
        }

        for (const processedUrl of processedUrls) {
            const trimmedUrl = typeof processedUrl === 'string' ? processedUrl.trim() : '';

            if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
                const { fetchSubscriptionWithFormat } = await import('../parsers/subscription/httpSubscriptionFetcher.js');

                try {
                    const fetchResult = await fetchSubscriptionWithFormat(trimmedUrl, userAgent);
                    if (!fetchResult) {
                        continue;
                    }

                    const { content, format, url: originalUrl } = fetchResult;
                    if (isCompatibleProviderFormat(format)) {
                        providerUrls.push(originalUrl);
                        continue;
                    }

                    const result = parseSubscriptionContent(content);
                    if (collectParsedConfig(result, parsedItems, configOverrides)) {
                        continue;
                    }

                    if (Array.isArray(result)) {
                        for (const item of result) {
                            if (item && typeof item === 'object' && item.tag) {
                                parsedItems.push(item);
                            } else if (typeof item === 'string') {
                                const subResult = await ProxyParser.parse(item, userAgent);
                                if (subResult) {
                                    parsedItems.push(subResult);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error processing HTTP subscription:', error);
                }
                continue;
            }

            const result = await ProxyParser.parse(processedUrl, userAgent);
            if (collectParsedConfig(result, parsedItems, configOverrides)) {
                continue;
            }

            if (Array.isArray(result)) {
                for (const item of result) {
                    if (item && typeof item === 'object' && item.tag) {
                        parsedItems.push(item);
                    } else if (typeof item === 'string') {
                        const subResult = await ProxyParser.parse(item, userAgent);
                        if (subResult) {
                            parsedItems.push(subResult);
                        }
                    }
                }
            } else if (result) {
                parsedItems.push(result);
            }
        }
    }

    return { parsedItems, providerUrls, configOverrides };
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const result = [];
    values.forEach((value) => {
        if (typeof value !== 'string') {
            return;
        }
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        result.push(trimmed);
    });
    return result;
}

export function buildDialerProxyTargets(parsedItems = [], {
    lang = 'zh-CN',
    selectedRules = [],
    customRules = [],
    groupByCountry = false,
    includeAutoSelect = true
} = {}) {
    const t = createTranslator(lang);
    const proxyNames = uniqueStrings(parsedItems.map((item) => item?.tag));
    const effectiveSelectedRules = Array.isArray(selectedRules) && selectedRules.length > 0
        ? selectedRules
        : PREDEFINED_RULE_SETS.minimal;
    const countryGroups = groupByCountry
        ? groupProxiesByCountry(parsedItems, { getName: (proxy) => proxy?.tag })
        : {};

    return uniqueStrings([
        ...proxyNames,
        t('outboundNames.Node Select'),
        ...(includeAutoSelect ? [t('outboundNames.Auto Select')] : []),
        ...(proxyNames.length > 0 ? [t('outboundNames.Manual Switch')] : []),
        ...Object.keys(countryGroups)
            .sort((a, b) => a.localeCompare(b))
            .map((country) => {
                const { emoji, name } = countryGroups[country] || {};
                return emoji && name ? `${emoji} ${name}` : '';
            }),
        ...getOutbounds(effectiveSelectedRules).map((outbound) => t(`outboundNames.${outbound}`)),
        ...((Array.isArray(customRules) ? customRules : [])
            .map((rule) => t(`outboundNames.${rule?.name || ''}`))),
        t('outboundNames.Fall Back')
    ]);
}
