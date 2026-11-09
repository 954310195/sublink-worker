import { decodeBase64 } from '../../utils.js';
import { parseSubscriptionContent } from './subscriptionContentParser.js';

const SUBSCRIPTION_URI_PATTERN = /^(ss|vmess|vless|hysteria|hysteria2|hy2|trojan|tuic|anytls|http|https):\/\//i;

function hasSubscriptionUriLine(content) {
    return content
        .split(/\r?\n/)
        .some(line => SUBSCRIPTION_URI_PATTERN.test(line.trim()));
}

function isPlainSubscriptionContent(content) {
    return typeof content === 'string' && content.length > 0 &&
        (detectFormat(content) !== 'unknown' || hasSubscriptionUriLine(content));
}

function decodeUriComponentIfNeeded(text) {
    const trimmed = text.trim();
    if (!trimmed.includes('%')) {
        return trimmed;
    }
    try {
        return decodeURIComponent(trimmed).trim();
    } catch {
        return trimmed;
    }
}

function normalizeBase64Candidate(text) {
    const compact = text.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) {
        return null;
    }
    const withoutPadding = compact.replace(/=+$/, '');
    if (withoutPadding.length % 4 === 1) {
        return null;
    }
    const normalized = withoutPadding.replace(/-/g, '+').replace(/_/g, '/');
    return normalized + '='.repeat((4 - normalized.length % 4) % 4);
}

/**
 * Decode only the subscription envelope; protocol parsers own URI parameters.
 * @param {string} text - Raw text content
 * @returns {string} - Decoded content
 */
function decodeContent(text) {
    const trimmed = text.trim();
    if (isPlainSubscriptionContent(trimmed)) {
        return trimmed;
    }
    const urlDecodedText = decodeUriComponentIfNeeded(trimmed);
    if (isPlainSubscriptionContent(urlDecodedText)) {
        return urlDecodedText;
    }
    const base64Candidate = normalizeBase64Candidate(urlDecodedText);
    if (!base64Candidate) {
        return urlDecodedText;
    }
    try {
        const decodedText = decodeBase64(base64Candidate).trim();
        if (isPlainSubscriptionContent(decodedText)) {
            return decodedText;
        }
        const uriDecodedText = decodeUriComponentIfNeeded(decodedText);
        if (isPlainSubscriptionContent(uriDecodedText)) {
            return uriDecodedText;
        }
    } catch {
        return urlDecodedText;
    }
    return urlDecodedText;
}

/**
 * Detect the format of subscription content
 * @param {string} content - Decoded subscription content
 * @returns {'clash'|'singbox'|'surge'|'unknown'} - Detected format
 */
function detectFormat(content) {
    const trimmed = content.trim();

    // Try JSON (Sing-Box format)
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.outbounds || parsed.inbounds || parsed.route) {
                return 'singbox';
            }
        } catch {
            // Not valid JSON
        }
    }

    // Try YAML (Clash format) - check for proxies: key
    if (trimmed.includes('proxies:')) {
        return 'clash';
    }

    if (/\[(General|Proxy|Rule|Proxy Group)\]/i.test(trimmed)) {
        return 'surge';
    }

    return 'unknown';
}

/**
 * Fetch subscription content from a URL and parse it
 * @param {string} url - The subscription URL to fetch
 * @param {string} userAgent - Optional User-Agent header
 * @returns {Promise<object|string[]|null>} - Parsed subscription content
 */
export async function fetchSubscription(url, userAgent) {
    try {
        const headers = new Headers();
        if (userAgent) {
            headers.set('User-Agent', userAgent);
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: headers
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const text = await response.text();
        const decodedText = decodeContent(text);

        return parseSubscriptionContent(decodedText);
    } catch (error) {
        console.error('Error fetching or parsing HTTP(S) content:', error);
        return null;
    }
}

/**
 * Fetch subscription content and detect its format without parsing
 * @param {string} url - The subscription URL to fetch
 * @param {string} userAgent - Optional User-Agent header
 * @returns {Promise<{content: string, format: 'clash'|'singbox'|'surge'|'unknown', url: string}|null>}
 */
export async function fetchSubscriptionWithFormat(url, userAgent) {
    try {
        const headers = new Headers();
        if (userAgent) {
            headers.set('User-Agent', userAgent);
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: headers
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const text = await response.text();
        const content = decodeContent(text);
        const format = detectFormat(content);

        return { content, format, url };
    } catch (error) {
        console.error('Error fetching subscription:', error);
        return null;
    }
}
