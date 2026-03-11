import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { StashConfigBuilder } from '../src/builders/StashConfigBuilder.js';

function parseStashYaml(output) {
    const lines = output.split('\n');
    const yamlBody = lines[0].startsWith('#SUBSCRIBED ') ? lines.slice(1).join('\n') : output;
    return yaml.load(yamlBody);
}

describe('StashConfigBuilder', () => {
    it('emits Stash-specific subscription header comment and dns fields', async () => {
        const config = 'vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogInRlc3QiLA0KICAiYWRkIjogIjEuMS4xLjEiLA0KICAicG9ydCI6ICI0NDMiLA0KICAiaWQiOiAiYWRkNjY2NjYtODg4OC04ODg4LTg4ODgtODg4ODg4ODg4ODg4IiwNCiAgImFpZCI6ICIwIiwNCiAgInNjeSI6ICJhdXRvIiwNCiAgIm5ldCI6ICJ3cyIsDQogICJ0eXBlIjogIm5vbmUiLA0KICAiaG9zdCI6ICIiLA0KICAicGF0aCI6ICIvIiwNCiAgInRscyI6ICJ0bHMiDQp9';
        const builder = new StashConfigBuilder(config, 'minimal', [], null, 'en-US', 'Stash/1.0');
        builder.setSubscriptionUrl('https://example.com/stash?config=abc');

        const output = await builder.build();
        const parsed = parseStashYaml(output);

        expect(output.startsWith('#SUBSCRIBED https://example.com/stash?config=abc')).toBe(true);
        expect(parsed?.dns?.['follow-rule']).toBe(false);
        expect(parsed?.dns).not.toHaveProperty('respect-rules');
        expect(parsed).not.toHaveProperty('geodata-mode');
        expect(parsed.proxies?.[0]?.type).toBe('vmess');
    });

    it('maps hysteria2 bandwidth fields to Stash format', async () => {
        const config = 'hy2://secret@example.com:443?sni=example.com&upmbps=100&downmbps=200#hy2-test';
        const builder = new StashConfigBuilder(config, 'minimal', [], null, 'en-US', 'Stash/1.0');

        const output = await builder.build();
        const parsed = parseStashYaml(output);
        const proxy = parsed.proxies?.find((item) => item?.name === 'hy2-test');

        expect(proxy).toBeDefined();
        expect(proxy.auth).toBe('secret');
        expect(proxy['up-speed']).toBe(100);
        expect(proxy['down-speed']).toBe(200);
        expect(proxy).not.toHaveProperty('password');
        expect(proxy).not.toHaveProperty('up');
        expect(proxy).not.toHaveProperty('down');
    });
});
