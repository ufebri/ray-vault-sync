import { SyncEngine } from '../src/sync-core';
import { ILocalVault, IGitHubClient, LocalFile, RemoteFile, SyncState } from '../src/interfaces';

class MockVault implements ILocalVault {
    public files: Record<string, LocalFile> = {};
    public syncState: SyncState | null = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: {} };

    async getFiles() { return Object.values(this.files); }
    async readFile(path: string) { return this.files[path]; }
    async writeFile(path: string, content: string | Uint8Array, isBinary: boolean) {
        const hash = 'hash-' + content.toString().length;
        this.files[path] = { path, hash, content: content as string, isBinary };
    }
    async deleteFile(path: string) { delete this.files[path]; }
    async renameFile(old: string, newPath: string) {
        this.files[newPath] = this.files[old];
        this.files[newPath].path = newPath;
        delete this.files[old];
    }
    async getSyncState() { return this.syncState; }
    async saveSyncState(s: SyncState) { this.syncState = s; }
}

class MockGitHub implements IGitHubClient {
    public headCommit = 'abc';
    public tree: RemoteFile[] = [];
    public blobs: Record<string, string> = {};

    async getHeadCommit(branch: string) { return this.headCommit; }
    async getTree(sha: string) { return this.tree; }
    async getBlob(sha: string) { return this.blobs[sha]; }
    async createTree() { return 'new-tree-sha'; }
    async createCommit(m: string, t: string, p: string[]) {
        this.headCommit = 'def';
        return this.headCommit;
    }
    async updateRef(b: string, c: string) { this.headCommit = c; }
    async createBlob(c: string | Uint8Array) {
        const sha = 'sha-' + c.toString().length;
        this.blobs[sha] = c as string;
        return sha;
    }
}

describe('SyncEngine (3-Way Merge Core)', () => {
    let vault: MockVault;
    let github: MockGitHub;
    let engine: SyncEngine;

    beforeEach(() => {
        vault = new MockVault();
        github = new MockGitHub();
        engine = new SyncEngine(vault, github);
    });

    test('Idempotency: Unchanged state leads to NOOP', async () => {
        vault.files = { 'file.md': { path: 'file.md', hash: 'h1', content: 'test', isBinary: false } };
        github.tree = [{ path: 'file.md', hash: 'h1', sha: 's1' }];
        vault.syncState = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: { 'file.md': 'h1' } };

        const { plan } = await engine.calculatePlan();
        expect(plan.length).toBe(1);
        expect(plan[0].action).toBe('NOOP');
    });

    test('Local Edit -> UPLOAD action', async () => {
        vault.files = { 'file.md': { path: 'file.md', hash: 'h2', content: 'test2', isBinary: false } };
        github.tree = [{ path: 'file.md', hash: 'h1', sha: 's1' }];
        vault.syncState = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: { 'file.md': 'h1' } };

        const { plan } = await engine.calculatePlan();
        expect(plan.find(p => p.path === 'file.md')?.action).toBe('UPLOAD');
    });

    test('Remote Edit -> DOWNLOAD action', async () => {
        vault.files = { 'file.md': { path: 'file.md', hash: 'h1', content: 'test', isBinary: false } };
        github.tree = [{ path: 'file.md', hash: 'h2', sha: 's2' }];
        vault.syncState = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: { 'file.md': 'h1' } };

        const { plan } = await engine.calculatePlan();
        expect(plan.find(p => p.path === 'file.md')?.action).toBe('DOWNLOAD');
    });

    test('Concurrent Edit on Both Sides -> CONFLICT preserved safely', async () => {
        vault.files = { 'file.md': { path: 'file.md', hash: 'h3', content: 'test3', isBinary: false } };
        github.tree = [{ path: 'file.md', hash: 'h2', sha: 's2' }];
        vault.syncState = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: { 'file.md': 'h1' } };

        const { plan } = await engine.calculatePlan();
        expect(plan.find(p => p.path === 'file.md')?.action).toBe('CONFLICT');
    });

    test('Remote Race Condition: throws safe error on branch drift', async () => {
        vault.files = { 'new.md': { path: 'new.md', hash: 'hn', content: 'new', isBinary: false } };
        github.tree = [];
        vault.syncState = { schemaVersion: 1, lastSyncedCommit: 'abc', baseFiles: {} };

        github.getHeadCommit = jest.fn()
            .mockResolvedValueOnce('abc')
            .mockResolvedValueOnce('moved-head-xyz');

        await expect(engine.executeSync()).rejects.toThrow("Remote race detected");
    });

    test('isIgnoredPath correctly blocks node_modules, hidden files, and custom excludes', () => {
        const { isIgnoredPath } = require('../src/sync-core');
        
        // Node modules
        expect(isIgnoredPath('node_modules/package/index.js')).toBe(true);
        expect(isIgnoredPath('subfolder/node_modules/package.json')).toBe(true);
        
        // Hidden files & directories
        expect(isIgnoredPath('.git/config')).toBe(true);
        expect(isIgnoredPath('.obsidian/workspace.json')).toBe(true);
        expect(isIgnoredPath('.DS_Store')).toBe(true);
        expect(isIgnoredPath('folder/.DS_Store')).toBe(true);

        // Internal sync state
        expect(isIgnoredPath('plugins/sync-state.json')).toBe(true);

        // Regular notes should NOT be ignored
        expect(isIgnoredPath('Notes/Meeting.md')).toBe(false);
        expect(isIgnoredPath('Daily/2026-08-26.md')).toBe(false);

        // Custom excludes
        const custom = ['templates', 'private/secret', 'archive'];
        expect(isIgnoredPath('templates/daily.md', custom)).toBe(true);
        expect(isIgnoredPath('private/secret/note.md', custom)).toBe(true);
        expect(isIgnoredPath('archive/old.md', custom)).toBe(true);
        expect(isIgnoredPath('public/note.md', custom)).toBe(false);
    });
});
