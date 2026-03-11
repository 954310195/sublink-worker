/**
 * Stash Configuration
 * Base configuration template tuned for Stash-specific fields.
 */

export const STASH_CONFIG = {
    port: 7890,
    'socks-port': 7891,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'rule-providers': {
        // Generated dynamically.
    },
    dns: {
        enable: true,
        ipv6: true,
        'enhanced-mode': 'fake-ip',
        'default-nameserver': [
            '223.5.5.5',
            '114.114.114.114'
        ],
        nameserver: [
            'https://120.53.53.53/dns-query',
            'https://223.5.5.5/dns-query'
        ],
        'follow-rule': false,
        'nameserver-policy': {
            'geosite:cn,private': [
                'https://120.53.53.53/dns-query',
                'https://223.5.5.5/dns-query'
            ],
            'geosite:geolocation-!cn': [
                'https://dns.cloudflare.com/dns-query',
                'https://dns.google/dns-query'
            ]
        }
    },
    proxies: [],
    'proxy-groups': []
};
