import { SyncEngine } from '../src/sync-core';
import { ILocalVault, IGitHubClient, LocalFile, RemoteFile, SyncState, GitTreeItem } from '../src/interfaces';

const localBase = 'a'.repeat(64);
const localEdit = 'b'.repeat(64);
const remoteBase = '1'.repeat(40);
const remoteEdit = '2'.repeat(40);
const sha256 = async (value: string | Uint8Array): Promise<string> => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

class MockVault implements ILocalVault {
    public files: Record<string, LocalFile> = {};
    public syncState: SyncState | null = {
        schemaVersion: 2,
        lastSyncedCommit: 'abc',
        baseFiles: {},
        remoteBaseFiles: {}
    };
    public operations: string[] = [];
    public invalidPaths = new Set<string>();
    public failWritePath: string | null = null;
    public activeMutations = 0;
    public maxActiveMutations = 0;

    async getFiles() { return Object.values(this.files); }
    async readFile(path: string) { return this.files[path]; }
    async pathExists(path: string) { return path in this.files; }
    async validatePath(path: string) {
        if (this.invalidPaths.has(path)) throw new Error(`invalid path: ${path}`);
    }
    async writeFile(path: string, content: string | Uint8Array, isBinary: boolean) {
        if (path === this.failWritePath) throw new Error('write failed');
        this.beginMutation(`write:${path}`);
        const hash = await sha256(content);
        this.files[path] = {
            path,
            hash,
            content: typeof content === 'string' ? content : undefined,
            binaryData: content instanceof Uint8Array ? content : undefined,
            isBinary
        };
        await Promise.resolve();
        this.endMutation();
    }
    async deleteFile(path: string) {
        this.beginMutation(`delete:${path}`);
        delete this.files[path];
        await Promise.resolve();
        this.endMutation();
    }
    async renameFile(old: string, newPath: string) {
        this.files[newPath] = this.files[old];
        this.files[newPath].path = newPath;
        delete this.files[old];
    }
    async getSyncState() { return this.syncState; }
    async saveSyncState(s: SyncState) { this.syncState = s; }
    getCustomExcludes() { return []; }

    private beginMutation(operation: string) {
        this.operations.push(operation);
        this.activeMutations++;
        this.maxActiveMutations = Math.max(this.maxActiveMutations, this.activeMutations);
    }

    private endMutation() {
        this.activeMutations--;
    }
}

class MockGitHub implements IGitHubClient {
    public headCommit = 'abc';
    public tree: RemoteFile[] = [];
    public commitTrees = new Map<string, RemoteFile[]>();
    public blobs: Record<string, Uint8Array> = {};
    public changes: GitTreeItem[] = [];
    public blobReads: string[] = [];
    public treeReads: string[] = [];
    public unavailableTrees = new Set<string>();
    public commitFailure: Error | null = null;
    private treeCounter = 0;

    async getHeadCommit(_branch: string) { return this.headCommit; }
    async getTree(sha: string) {
        this.treeReads.push(sha);
        if (this.unavailableTrees.has(sha)) throw new Error('missing mock commit');
        return this.commitTrees.get(sha) ?? this.tree;
    }
    async getBlob(sha: string, isBinary: boolean) {
        const bytes = await this.getBlobBytes(sha);
        return isBinary ? bytes : new TextDecoder().decode(bytes);
    }
    async getBlobBytes(sha: string) {
        this.blobReads.push(sha);
        const bytes = this.blobs[sha];
        if (!bytes) throw new Error('missing mock blob');
        return bytes;
    }
    async createTree(base: string, changes: GitTreeItem[]) {
        this.changes.push(...changes);
        let nextTree = [...(this.commitTrees.get(base) ?? this.tree)].filter(file => !changes.some(change =>
            change.path === file.path && change.sha === null
        ));
        for (const change of changes) {
            if (change.sha === null) continue;
            const sha = change.sha ?? `created-${change.path}`;
            nextTree = nextTree.filter(file => file.path !== change.path);
            nextTree.push({ path: change.path, sha });
        }
        const treeSha = `tree-${this.treeCounter++}`;
        this.commitTrees.set(treeSha, nextTree);
        return treeSha;
    }
    async createCommit(_message: string, tree: string, _parents: string[]) {
        if (this.commitFailure) throw this.commitFailure;
        this.commitTrees.set('def', this.commitTrees.get(tree) ?? this.tree);
        return 'def';
    }
    async updateRef(_branch: string, commit: string) {
        this.headCommit = commit;
        this.tree = this.commitTrees.get(commit) ?? this.tree;
    }
    async createBlob(content: string | Uint8Array) {
        const sha = `created-${Object.keys(this.blobs).length}`;
        this.blobs[sha] = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        return sha;
    }
}

const file = (path: string, hash: string, content = 'local', isBinary = false): LocalFile => ({
    path,
    hash,
    content: isBinary ? undefined : content,
    binaryData: isBinary ? new TextEncoder().encode(content) : undefined,
    isBinary
});

const remoteFile = (path: string, sha: string): RemoteFile => ({ path, sha });
const state = (
    baseFiles: Record<string, string>,
    remoteBaseFiles: Record<string, string> = {}
): SyncState => ({
    schemaVersion: 2,
    lastSyncedCommit: 'abc',
    baseFiles,
    remoteBaseFiles
});

describe('SyncEngine (3-Way Merge Core)', () => {
    let vault: MockVault;
    let github: MockGitHub;
    let engine: SyncEngine;

    beforeEach(() => {
        vault = new MockVault();
        github = new MockGitHub();
        engine = new SyncEngine(vault, github);
    });

    test('unchanged files are NOOP without downloading remote blobs', async () => {
        vault.files = { 'file.md': file('file.md', localBase) };
        github.tree = [remoteFile('file.md', remoteBase)];
        vault.syncState = state({ 'file.md': localBase }, { 'file.md': remoteBase });

        const { plan } = await engine.calculatePlan();

        expect(plan[0].action).toBe('NOOP');
        expect(github.blobReads).toEqual([]);
    });

    test('local and remote-only edits select upload and download', async () => {
        vault.files = {
            'upload.md': file('upload.md', localEdit),
            'download.md': file('download.md', localBase)
        };
        github.tree = [
            remoteFile('upload.md', remoteBase),
            remoteFile('download.md', remoteEdit)
        ];
        vault.syncState = state(
            { 'upload.md': localBase, 'download.md': localBase },
            { 'upload.md': remoteBase, 'download.md': remoteBase }
        );

        const { plan } = await engine.calculatePlan();

        expect(plan.find(item => item.path === 'upload.md')?.action).toBe('UPLOAD');
        expect(plan.find(item => item.path === 'download.md')?.action).toBe('DOWNLOAD');
        expect(github.blobReads).toEqual([]);
    });

    test('same bytes on concurrently changed sides remain NOOP after one candidate fetch', async () => {
        const sameBytes = 'identical concurrent edit';
        const sameHash = await sha256(sameBytes);
        vault.files = { 'file.md': file('file.md', sameHash, sameBytes) };
        github.tree = [remoteFile('file.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode(sameBytes);
        vault.syncState = state({ 'file.md': localBase }, { 'file.md': remoteBase });

        const { plan } = await engine.calculatePlan();

        expect(plan[0].action).toBe('NOOP');
        expect(github.blobReads).toEqual([remoteEdit]);
    });

    test('concurrent different edits preserve local content and save remote conflict copy', async () => {
        vault.files = { 'file.md': file('file.md', localEdit, 'local edit') };
        github.tree = [remoteFile('file.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode('remote edit');
        vault.syncState = state({ 'file.md': localBase }, { 'file.md': remoteBase });

        await engine.executeSync();

        const conflictPath = Object.keys(vault.files).find(path => path.includes('.conflict-'));
        expect(vault.files['file.md'].content).toBe('local edit');
        expect(conflictPath).toBeDefined();
        expect(vault.files[conflictPath!].content).toBe('remote edit');
        expect(github.changes).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'file.md', content: 'local edit' }),
            expect.objectContaining({ path: conflictPath, content: 'remote edit' })
        ]));
        expect(vault.syncState?.schemaVersion).toBe(2);
        expect(vault.syncState?.baseFiles['file.md']).toBe(localEdit);
        expect(vault.syncState?.remoteBaseFiles?.['file.md']).toBe(`created-file.md`);
    });

    test('deletions propagate when the remaining side still matches its baseline', async () => {
        vault.files = {
            'propagate-remote-delete.md': file('propagate-remote-delete.md', localBase)
        };
        github.tree = [
            remoteFile('propagate-local-delete.md', remoteBase)
        ];
        vault.syncState = state(
            { 'propagate-remote-delete.md': localBase, 'propagate-local-delete.md': localBase },
            { 'propagate-remote-delete.md': remoteBase, 'propagate-local-delete.md': remoteBase }
        );

        const { plan } = await engine.calculatePlan();
        expect(plan.find(item => item.path === 'propagate-local-delete.md')?.action).toBe('DELETE_REMOTE');
        expect(plan.find(item => item.path === 'propagate-remote-delete.md')?.action).toBe('DELETE_LOCAL');

        await engine.executeSync();

        expect(github.changes).toContainEqual(expect.objectContaining({
            path: 'propagate-local-delete.md',
            sha: null
        }));
        expect(vault.files['propagate-remote-delete.md']).toBeUndefined();
    });

    test('local edit is re-uploaded when remote deleted its prior copy', async () => {
        vault.files = { 'file.md': file('file.md', localEdit, 'kept local edit') };
        github.tree = [];
        vault.syncState = state({ 'file.md': localBase }, { 'file.md': remoteBase });

        const { plan } = await engine.calculatePlan();
        expect(plan[0].action).toBe('UPLOAD');

        await engine.executeSync();

        expect(github.changes).toContainEqual(expect.objectContaining({ path: 'file.md' }));
        expect(vault.files['file.md'].content).toBe('kept local edit');
    });

    test('remote edit is restored locally instead of being erased by a local deletion', async () => {
        github.tree = [remoteFile('file.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode('preserved remote edit');
        vault.syncState = state({ 'file.md': localBase }, { 'file.md': remoteBase });

        const { plan } = await engine.calculatePlan();
        expect(plan[0].action).toBe('DOWNLOAD');

        await engine.executeSync();

        expect(vault.files['file.md'].content).toBe('preserved remote edit');
        expect(github.changes).toEqual([]);
    });

    test('upload refreshes Git SHA baseline from the new commit tree', async () => {
        vault.files = { 'new.md': file('new.md', localEdit, 'new content') };
        github.tree = [];
        vault.syncState = state({}, {});

        await engine.executeSync();

        expect(github.treeReads).toContain('def');
        expect(vault.syncState?.remoteBaseFiles?.['new.md']).toBe('created-new.md');
    });

    test('v1 migration recovers stored baseline blobs and saves separate SHA-256 and Git SHA baselines', async () => {
        const baselineContent = 'old baseline';
        const currentContent = 'remote content after the old blob left the branch';
        const baselineBytes = new TextEncoder().encode(baselineContent);
        const oldGitSha = '3'.repeat(40);
        const currentGitSha = '5'.repeat(40);
        const baselineHash = await sha256(baselineBytes);
        vault.files = { 'file.md': file('file.md', baselineHash, baselineContent) };
        github.tree = [remoteFile('file.md', currentGitSha)];
        github.blobs[oldGitSha] = baselineBytes;
        github.blobs[currentGitSha] = new TextEncoder().encode(currentContent);
        vault.syncState = {
            schemaVersion: 1,
            lastSyncedCommit: 'abc',
            baseFiles: { 'file.md': oldGitSha }
        };

        await engine.executeSync();

        expect(github.blobReads).toEqual([oldGitSha, currentGitSha]);
        expect(vault.syncState).toEqual({
            schemaVersion: 2,
            lastSyncedCommit: 'abc',
            baseFiles: { 'file.md': await sha256(currentContent) },
            remoteBaseFiles: { 'file.md': currentGitSha }
        });
        expect(vault.files['file.md'].content).toBe(currentContent);
    });

    test('migration failure aborts before any vault mutation or remote commit', async () => {
        vault.files = { 'file.md': file('file.md', localEdit, 'keep local') };
        github.tree = [];
        vault.syncState = {
            schemaVersion: 1,
            lastSyncedCommit: 'abc',
            baseFiles: { 'file.md': '4'.repeat(40) }
        };

        await expect(engine.executeSync()).rejects.toThrow(
            'Cannot migrate v1 sync state: baseline content for "file.md" could not be recovered'
        );

        expect(vault.operations).toEqual([]);
        expect(vault.files['file.md'].content).toBe('keep local');
        expect(github.changes).toEqual([]);
        expect(vault.syncState?.schemaVersion).toBe(1);
    });

    test('destructive local operations remain sequential', async () => {
        vault.files = {
            'one.md': file('one.md', localBase),
            'two.md': file('two.md', localBase)
        };
        github.tree = [];
        vault.syncState = state(
            { 'one.md': localBase, 'two.md': localBase },
            { 'one.md': remoteBase, 'two.md': remoteEdit }
        );

        await engine.executeSync();

        expect(vault.operations).toEqual(['delete:one.md', 'delete:two.md']);
        expect(vault.maxActiveMutations).toBe(1);
    });

    test('unknown or mixed baseline hash formats are rejected', async () => {
        vault.syncState = {
            schemaVersion: 2,
            lastSyncedCommit: 'abc',
            baseFiles: { 'file.md': '4'.repeat(40) },
            remoteBaseFiles: { 'file.md': remoteBase }
        };

        await expect(engine.calculatePlan()).rejects.toThrow('refusing to reinterpret its hash');
    });

    test('remote race condition throws safe error on branch drift', async () => {
        vault.files = { 'new.md': file('new.md', localEdit, 'new') };
        github.getHeadCommit = jest.fn()
            .mockResolvedValueOnce('abc')
            .mockResolvedValueOnce('moved-head');

        await expect(engine.executeSync()).rejects.toThrow('Remote race detected');
    });

    test('preflights every mutating path before writing any plan item', async () => {
        const savedState = state({ 'first.md': localBase }, { 'first.md': remoteBase });
        vault.syncState = savedState;
        vault.files = { 'first.md': file('first.md', localBase) };
        github.tree = [
            remoteFile('first.md', remoteEdit),
            remoteFile('late:invalid.md', remoteEdit)
        ];
        vault.invalidPaths.add('late:invalid.md');

        await expect(engine.executeSync()).rejects.toThrow('late:invalid.md');

        expect(vault.operations).toEqual([]);
        expect(vault.syncState).toBe(savedState);
        expect(github.headCommit).toBe('abc');
        expect(github.changes).toEqual([]);
    });

    test('marks a failed local write as unsafe to retry automatically', async () => {
        const savedState = state({}, {});
        vault.syncState = savedState;
        vault.failWritePath = 'remote.md';
        github.tree = [remoteFile('remote.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode('remote content');

        await expect(engine.executeSync()).rejects.toThrow('changes began');

        expect(vault.syncState).toBe(savedState);
        expect(github.headCommit).toBe('abc');
        expect(github.changes).toEqual([]);
    });

    test('reuses one deterministic conflict snapshot after a remote commit failure', async () => {
        vault.files = { 'file.md': file('file.md', localEdit, 'local edit') };
        github.tree = [remoteFile('file.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode('remote edit');
        const savedState = state({ 'file.md': localBase }, { 'file.md': remoteBase });
        vault.syncState = savedState;
        github.commitFailure = new Error('commit unavailable');

        await expect(engine.executeSync()).rejects.toThrow('changes began');

        const snapshotPath = Object.keys(vault.files).find(path => path.includes('.conflict-'));
        expect(snapshotPath).toMatch(new RegExp(`\\.conflict-${remoteEdit}\\.md$`));
        expect(Object.keys(vault.files).filter(path => path.includes('.conflict-'))).toHaveLength(1);
        expect(vault.syncState).toBe(savedState);
        expect(github.headCommit).toBe('abc');

        github.commitFailure = null;
        await engine.executeSync();

        expect(Object.keys(vault.files).filter(path => path.includes('.conflict-'))).toEqual([snapshotPath]);
        expect(github.tree.filter(file => file.path === snapshotPath)).toHaveLength(1);
        expect(vault.files[snapshotPath!].content).toBe('remote edit');
    });

    test('rejects an edited conflict snapshot without overwriting it', async () => {
        const snapshotPath = `file.conflict-${remoteEdit}.md`;
        vault.files = {
            'file.md': file('file.md', localEdit, 'local edit'),
            [snapshotPath]: file(snapshotPath, await sha256('user-edited snapshot'), 'user-edited snapshot')
        };
        github.tree = [remoteFile('file.md', remoteEdit)];
        github.blobs[remoteEdit] = new TextEncoder().encode('remote edit');
        const savedState = state({ 'file.md': localBase }, { 'file.md': remoteBase });
        vault.syncState = savedState;

        await expect(engine.executeSync()).rejects.toThrow('snapshot collision');

        expect(vault.operations).toEqual([]);
        expect(vault.files[snapshotPath].content).toBe('user-edited snapshot');
        expect(vault.syncState).toBe(savedState);
        expect(github.headCommit).toBe('abc');
        expect(github.changes).toEqual([]);
    });

    test('migrates an allowlisted hidden baseline from the saved commit tree', async () => {
        const path = 'Medium Posts/.automation/model-state.json';
        const baselineBytes = new TextEncoder().encode('saved baseline');
        const updatedBytes = new TextEncoder().encode('Worker update');
        vault.files = { [path]: file(path, await sha256(baselineBytes), 'saved baseline') };
        vault.syncState = state({}, {});
        github.headCommit = 'current';
        github.tree = [remoteFile(path, remoteEdit)];
        github.commitTrees.set('abc', [remoteFile(path, remoteBase)]);
        github.blobs[remoteBase] = baselineBytes;
        github.blobs[remoteEdit] = updatedBytes;

        const { plan, baseState } = await engine.calculatePlan();

        expect(plan.find(item => item.path === path)?.action).toBe('DOWNLOAD');
        expect(baseState.baseFiles[path]).toBe(await sha256(baselineBytes));
        expect(baseState.remoteBaseFiles?.[path]).toBe(remoteBase);
        expect(github.treeReads).toContain('abc');
    });

    test('uploads local-only changes to allowlisted hidden state after baseline migration', async () => {
        const path = 'Medium Posts/.automation/model-registry.json';
        const baselineBytes = new TextEncoder().encode('saved baseline');
        const localContent = 'local preparation';
        vault.files = { [path]: file(path, await sha256(localContent), localContent) };
        vault.syncState = state({}, {});
        github.headCommit = 'current';
        github.tree = [remoteFile(path, remoteBase)];
        github.commitTrees.set('abc', [remoteFile(path, remoteBase)]);
        github.blobs[remoteBase] = baselineBytes;

        await engine.executeSync();

        expect(github.changes).toContainEqual(expect.objectContaining({ path, content: localContent }));
    });

    test('converges equal concurrent edits to allowlisted hidden state', async () => {
        const path = 'Medium Posts/.automation/visual-catalog.json';
        const baselineBytes = new TextEncoder().encode('saved baseline');
        const currentBytes = new TextEncoder().encode('same current content');
        vault.files = { [path]: file(path, await sha256(currentBytes), 'same current content') };
        vault.syncState = state({}, {});
        github.headCommit = 'current';
        github.tree = [remoteFile(path, remoteEdit)];
        github.commitTrees.set('abc', [remoteFile(path, remoteBase)]);
        github.blobs[remoteBase] = baselineBytes;
        github.blobs[remoteEdit] = currentBytes;

        const { plan } = await engine.calculatePlan();

        expect(plan.find(item => item.path === path)?.action).toBe('NOOP');
    });

    test('preserves divergent allowlisted hidden state on both sides', async () => {
        const path = 'Medium Posts/.automation/model-state.json';
        const baselineBytes = new TextEncoder().encode('saved baseline');
        const remoteBytes = new TextEncoder().encode('remote Worker update');
        vault.files = { [path]: file(path, await sha256('local edit'), 'local edit') };
        vault.syncState = state({}, {});
        github.headCommit = 'current';
        github.tree = [remoteFile(path, remoteEdit)];
        github.commitTrees.set('abc', [remoteFile(path, remoteBase)]);
        github.blobs[remoteBase] = baselineBytes;
        github.blobs[remoteEdit] = remoteBytes;

        await engine.executeSync();

        const snapshot = Object.keys(vault.files).find(filePath => filePath.includes(`.conflict-${remoteEdit}`));
        expect(vault.files[path].content).toBe('local edit');
        expect(snapshot).toBeDefined();
        expect(vault.files[snapshot!].content).toBe('remote Worker update');
        expect(github.tree.map(file => file.path)).toContain(snapshot);
    });

    test('fails closed when the saved hidden-file commit or blob is unavailable', async () => {
        const path = 'Medium Posts/.automation/model-state.json';
        vault.files = { [path]: file(path, localEdit, 'local edit') };
        vault.syncState = state({}, {});
        github.headCommit = 'current';
        github.tree = [remoteFile(path, remoteEdit)];
        github.unavailableTrees.add('abc');

        await expect(engine.executeSync()).rejects.toThrow('saved Git commit');
        expect(vault.operations).toEqual([]);
        expect(github.headCommit).toBe('current');

        github.unavailableTrees.clear();
        github.commitTrees.set('abc', [remoteFile(path, remoteBase)]);
        await expect(engine.executeSync()).rejects.toThrow('baseline blob');
        expect(vault.operations).toEqual([]);
        expect(github.headCommit).toBe('current');
    });

    test('isIgnoredPath blocks internal, hidden, and excluded files', () => {
        const { isIgnoredPath } = require('../src/sync-core');

        expect(isIgnoredPath('node_modules/package/index.js')).toBe(true);
        expect(isIgnoredPath('subfolder/node_modules/package.json')).toBe(true);
        expect(isIgnoredPath('.git/config')).toBe(true);
        expect(isIgnoredPath('.obsidian/workspace.json')).toBe(true);
        expect(isIgnoredPath('.DS_Store')).toBe(true);
        expect(isIgnoredPath('plugins/sync-state.json')).toBe(true);
        expect(isIgnoredPath('Medium Posts/.automation/model-registry.json')).toBe(false);
        expect(isIgnoredPath(`Medium Posts/.automation/model-state.conflict-${remoteBase}.json`)).toBe(false);
        expect(isIgnoredPath('Medium Posts/.automation/private.json')).toBe(true);
        expect(isIgnoredPath('Notes/Meeting.md')).toBe(false);
        expect(isIgnoredPath('templates/daily.md', ['templates'])).toBe(true);
    });
});
