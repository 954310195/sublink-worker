import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
    generateRules, generateRuleSets, generateClashRuleSets, generateStashRuleSets
} from '../src/config/ruleGenerators.js';
import {
    SITE_RULE_SET_BASE_URL, IP_RULE_SET_BASE_URL,
    CLASH_SITE_RULE_SET_BASE_URL, CLASH_IP_RULE_SET_BASE_URL
} from '../src/config/ruleUrls.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { StashConfigBuilder } from '../src/builders/StashConfigBuilder.js';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';

const VALID_IDS = ['geolocation-!cn', 'category-ai-!cn', 'My_Rules-v2.0'];
const INVALID_IDS = [
    '.', '..', '../private', 'rules/../../private', '..\\private', 'rules\\private',
    'rules..private', '.hidden', 'trailing.', '//evil.example/rules',
    'https://evil.example/rules', 'rules?redirect=evil', 'rules#fragment', 'rules:443',
    '%2e%2e%2fprivate', 'rules%252fprivate', 'two words', 'rules\ninjected', 'rules\0injected'
];
const INPUT = 'ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#Test-Node';

function makeCustomRule() {
    return {
        name: 'Custom',
        site: [...VALID_IDS, ...INVALID_IDS],
        ip: ['custom_geo-!cn', ...INVALID_IDS],
        domain_suffix: 'example.org',
        domain_keyword: 'ads/tracker',
        ip_cidr: '2001:db8::/32',
        src_ip_cidr: '192.168.2.0/24',
        protocol: 'http'
    };
}

async function buildConfig(format) {
    const Builder = {
        Clash: ClashConfigBuilder,
        Stash: StashConfigBuilder,
        Singbox: SingboxConfigBuilder
    }[format];
    const builder = new Builder(INPUT, 'minimal', [makeCustomRule()], null, 'zh-CN', 'test-agent');
    const output = await builder.build();
    return typeof output === 'string' ? yaml.load(output) : output;
}

describe('custom rule identifier validation', () => {
    it.each(['array', 'comma-separated string'])('preserves legal names supplied as %s', (inputType) => {
        const names = [...VALID_IDS, 'google', 'cn'];
        const values = inputType === 'array'
            ? names.map(name => ` ${name} `)
            : ` ${names.join(', ')}, `;
        const [rule] = generateRules('minimal', [{ name: 'Custom', site: values, ip: values }]);

        expect(rule.site_rules).toEqual(names);
        expect(rule.ip_rules).toEqual(names);
    });

    it('filters only identifiers while preserving direct matching fields and preset rules', () => {
        const rules = generateRules('balanced', [makeCustomRule()]);

        expect(rules[0]).toEqual({
            outbound: 'Custom', site_rules: VALID_IDS, ip_rules: ['custom_geo-!cn'],
            domain_suffix: ['example.org'], domain_keyword: ['ads/tracker'],
            ip_cidr: ['2001:db8::/32'], src_ip_cidr: ['192.168.2.0/24'], protocol: ['http']
        });
        expect(rules.slice(1)).toEqual(generateRules('balanced'));
    });

    it.each([
        ['Singbox', generateRuleSets],
        ['Clash MRS', (preset, rules) => generateClashRuleSets(preset, rules, true)],
        ['Clash YAML', (preset, rules) => generateClashRuleSets(preset, rules, false)],
        ['Stash MRS', (preset, rules) => generateStashRuleSets(preset, rules, true)],
        ['Stash YAML', (preset, rules) => generateStashRuleSets(preset, rules, false)]
    ])('does not add injected URLs or paths to %s rule sets', (_format, generate) => {
        const rejectedRules = [{ name: 'Rejected', site: INVALID_IDS, ip: INVALID_IDS }];

        expect(generate('balanced', rejectedRules)).toEqual(generate('balanced', []));
    });

    it.each([
        ['Clash', generateClashRuleSets],
        ['Stash', generateStashRuleSets]
    ])('preserves legal ! names in %s YAML-format providers', (_format, generate) => {
        const { site_rule_providers, ip_rule_providers } = generate('minimal', [makeCustomRule()], false);

        for (const name of VALID_IDS) {
            expect(site_rule_providers[name]).toMatchObject({
                format: 'yaml', url: `${CLASH_SITE_RULE_SET_BASE_URL}${name}.yaml`
            });
        }
        expect(ip_rule_providers['custom_geo-!cn-ip']).toMatchObject({
            format: 'yaml', url: `${CLASH_IP_RULE_SET_BASE_URL}custom_geo-!cn.yaml`
        });
    });

    it.each(['Clash', 'Stash', 'Singbox'])('keeps safe references and removes injected identifiers from %s output', async (format) => {
        const config = await buildConfig(format);

        if (format === 'Singbox') {
            const customRules = config.route.rules.filter(rule => rule.outbound === 'Custom');
            const references = customRules.flatMap(rule => rule.rule_set || []);
            expect(references).toEqual([...VALID_IDS, 'custom_geo-!cn-ip']);

            for (const name of VALID_IDS) {
                expect(config.route.rule_set).toEqual(expect.arrayContaining([
                    expect.objectContaining({ tag: name, url: `${SITE_RULE_SET_BASE_URL}geosite-${name}.srs` })
                ]));
            }
            expect(config.route.rule_set).toEqual(expect.arrayContaining([
                expect.objectContaining({ tag: 'custom_geo-!cn-ip', url: `${IP_RULE_SET_BASE_URL}geoip-custom_geo-!cn.srs` })
            ]));
            expect(customRules).toEqual(expect.arrayContaining([
                expect.objectContaining({ domain_suffix: ['example.org'], domain_keyword: ['ads/tracker'], protocol: ['http'] }),
                expect.objectContaining({ ip_cidr: ['2001:db8::/32'], protocol: ['http'] }),
                expect.objectContaining({ source_ip_cidr: ['192.168.2.0/24'], protocol: ['http'] })
            ]));
            const allTags = config.route.rule_set.map(rule => rule.tag);
            for (const invalid of INVALID_IDS) {
                expect(allTags).not.toContain(invalid);
                expect(allTags).not.toContain(`${invalid}-ip`);
            }
        } else {
            const customReferences = config.rules.filter(rule => rule.startsWith('RULE-SET,') && rule.includes(',Custom'));
            expect(customReferences).toEqual([
                ...VALID_IDS.map(name => `RULE-SET,${name},Custom`),
                'RULE-SET,custom_geo-!cn-ip,Custom,no-resolve'
            ]);
            for (const name of VALID_IDS) {
                expect(config['rule-providers'][name]).toMatchObject({
                    format: 'mrs', url: `${CLASH_SITE_RULE_SET_BASE_URL}${name}.mrs`
                });
                if (format === 'Clash') {
                    expect(config['rule-providers'][name].path).toBe(`./ruleset/${name}.mrs`);
                }
            }
            expect(config['rule-providers']['custom_geo-!cn-ip'].url).toBe(`${CLASH_IP_RULE_SET_BASE_URL}custom_geo-!cn.mrs`);
            expect(config.rules).toEqual(expect.arrayContaining([
                'DOMAIN-SUFFIX,example.org,Custom', 'DOMAIN-KEYWORD,ads/tracker,Custom',
                'IP-CIDR,2001:db8::/32,Custom,no-resolve', 'SRC-IP-CIDR,192.168.2.0/24,Custom'
            ]));
            for (const invalid of INVALID_IDS) {
                expect(Object.hasOwn(config['rule-providers'], invalid)).toBe(false);
                expect(Object.hasOwn(config['rule-providers'], `${invalid}-ip`)).toBe(false);
            }
        }
    });
});
