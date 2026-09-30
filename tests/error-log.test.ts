import { ErrorLogManager, redactText } from '../src/error-log';

function makeApp() {
    const store = new Map<string, string>();
    return {
        vault: {
            configDir: '.obsidian',
            adapter: {
                async exists(p: string) { return store.has(p); },
                async read(p: string) {
                    const v = store.get(p);
                    if (v === undefined) throw new Error('not found');
                    return v;
                },
                async write(p: string, d: string) { store.set(p, d); },
                async mkdir() { /* noop */ }
            }
        },
        store
    };
}

describe('ErrorLogManager (local crash log)', () => {
    test('redacts token, PAT pattern, and Bearer header', () => {
        const token = 'mytoken1234';
        expect(redactText(`failed with ${token}`, [token])).toBe('failed with [REDACTED]');
        expect(redactText('key github_pat_abcXYZ_123 here', [])).toBe('key [REDACTED] here');
        expect(redactText('Authorization: Bearer abc.def-ghi', [])).toContain('Bearer [REDACTED]');
    });

    test('persists entries and formats recent', async () => {
        const app = makeApp();
        const mgr = new ErrorLogManager(app as never, () => [], '1.2.0', 'desktop');
        await mgr.log('runSync', new Error('boom'));
        const recent = await mgr.getRecent(5);
        expect(recent.length).toBe(1);
        expect(recent[0].source).toBe('runSync');
        expect(recent[0].message).toBe('boom');
        const text = await mgr.formatRecent(5);
        expect(text).toContain('runSync');
    });

    test('caps at 50 entries and redacts secrets on write', async () => {
        const app = makeApp();
        const mgr = new ErrorLogManager(app as never, () => ['secret-token'], '1.2.0', 'mobile');
        for (let i = 0; i < 60; i++) {
            await mgr.log('src', new Error(`err-${i} secret-token`));
        }
        const recent = await mgr.getRecent(100);
        expect(recent.length).toBe(50);
        expect(recent[0].message).toContain('err-59');
        expect(recent[0].message).not.toContain('secret-token');
    });

    test('handles non-Error values and corrupt storage without throwing', async () => {
        const app = makeApp();
        const mgr = new ErrorLogManager(app as never, () => [], 'dev', 'desktop');
        await mgr.log('widget', 'plain string failure');
        await mgr.log('widget', undefined);
        app.store.set('.obsidian/plugins/ray-vault-sync/error-log.json', 'not-json{{{');
        await expect(mgr.getRecent(5)).resolves.toEqual([]);
        await expect(mgr.log('after-corrupt', new Error('ok'))).resolves.toBeUndefined();
    });

    test('clear empties the log', async () => {
        const app = makeApp();
        const mgr = new ErrorLogManager(app as never, () => [], 'dev', 'desktop');
        await mgr.log('a', new Error('x'));
        await mgr.clear();
        await expect(mgr.getRecent(5)).resolves.toEqual([]);
        await expect(mgr.formatRecent(5)).resolves.toBe('No errors logged.');
    });
});
