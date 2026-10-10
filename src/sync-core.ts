import { ILocalVault, IGitHubClient, LocalFile, RemoteFile, SyncState, GitTreeItem } from './interfaces';

export function isIgnoredPath(path: string, customExcludes: string[] = []): boolean {
    if (!path) return true;
    // Hidden files & directories (.git, .obsidian, .trash, .DS_Store, etc.)
    if (path.startsWith('.') || path.includes('/.')) return true;
    
    // Dependency directories
    if (path === 'node_modules' || path.startsWith('node_modules/') || path.includes('/node_modules/')) return true;
    
    // Internal plugin state or OS junk
    if (path.includes('sync-state.json')) return true;
    if (path.endsWith('.DS_Store') || path.endsWith('Thumbs.db')) return true;

    // Custom user excludes
    for (const pattern of customExcludes) {
        let clean = pattern.trim();
        while (clean.startsWith('/')) clean = clean.slice(1);
        while (clean.endsWith('/')) clean = clean.slice(0, -1);
        if (!clean) continue;
        if (
            path === clean ||
            path.startsWith(clean + '/') ||
            path.includes('/' + clean + '/') ||
            path.endsWith('/' + clean) ||
            path.includes(clean)
        ) {
            return true;
        }
    }
    
    return false;
}

export type SyncActionType = 
    | 'UPLOAD' 
    | 'DOWNLOAD' 
    | 'DELETE_LOCAL' 
    | 'DELETE_REMOTE' 
    | 'CONFLICT' 
    | 'NOOP';

export interface FileSyncPlan {
    path: string;
    action: SyncActionType;
    localHash?: string;
    baseHash?: string;
    baseRemoteHash?: string;
    remoteSha?: string;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeText(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes);
}

function isSha1(value: string): boolean {
    return /^[a-f0-9]{40}$/i.test(value);
}

function isSha256(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
}

interface SyncProcessingState {
    newBaseFiles: Record<string, string>;
    treeChanges: GitTreeItem[];
    hasUploadsOrDeletes: boolean;
    remoteContent: Map<string, Uint8Array>;
}

export class SyncEngine {
    constructor(
        private readonly local: ILocalVault,
        private readonly remote: IGitHubClient,
        private readonly branch: string = 'main'
    ) {}

    public async calculatePlan(): Promise<{
        plan: FileSyncPlan[],
        remoteHead: string,
        baseState: SyncState,
        localMap: Map<string, LocalFile>,
        remoteTree: RemoteFile[],
        remoteContent: Map<string, Uint8Array>
    }> {
        const remoteHead = await this.remote.getHeadCommit(this.branch);
        const remoteTree = await this.remote.getTree(remoteHead);
        const localFiles = await this.local.getFiles();
        
        const storedState = await this.local.getSyncState();
        const baseState = await this.upgradeState(storedState);
        const remoteContent = new Map<string, Uint8Array>();
        const plan = await this.reconcile(baseState, localFiles, remoteTree, remoteContent);
        const localMap = new Map<string, LocalFile>();
        for (const lf of localFiles) localMap.set(lf.path, lf);

        return { plan, remoteHead, baseState, localMap, remoteTree, remoteContent };
    }

    private async upgradeState(storedState: SyncState | null): Promise<SyncState> {
        if (!storedState) return { schemaVersion: 2, lastSyncedCommit: '', baseFiles: {}, remoteBaseFiles: {} };
        if (storedState.schemaVersion === 2) return this.validateCurrentState(storedState);
        if (storedState.schemaVersion !== undefined && storedState.schemaVersion !== 1) {
            throw new Error(`Unsupported sync state schema version ${storedState.schemaVersion}.`);
        }
        return this.migrateLegacyState(storedState);
    }

    private validateCurrentState(state: SyncState): SyncState {
        if (!state.remoteBaseFiles) {
            throw new Error('Invalid sync state schema v2: remote SHA baselines are missing.');
        }
        for (const [path, hash] of Object.entries(state.baseFiles)) {
            if (!isSha256(hash) || !isSha1(state.remoteBaseFiles[path] ?? '')) {
                throw new Error(`Invalid sync state baseline for "${path}"; refusing to reinterpret its hash.`);
            }
        }
        for (const path of Object.keys(state.remoteBaseFiles)) {
            if (!(path in state.baseFiles)) {
                throw new Error(`Invalid sync state remote baseline for "${path}"; refusing to reinterpret its hash.`);
            }
        }
        return state;
    }

    private async migrateLegacyState(storedState: SyncState): Promise<SyncState> {
        // v1 used Git SHA-1 values as both local and remote baselines. Recover each
        // historical blob by its stored object ID before allowing any vault writes.
        const baselines = await Object.entries(storedState.baseFiles).reduce(
            async (previous, [path, oldSha]) => {
                const migrated = await previous;
                const baseline = await this.migrateLegacyBaseline(path, oldSha);
                migrated.baseFiles[path] = baseline.localHash;
                migrated.remoteBaseFiles[path] = baseline.remoteSha;
                return migrated;
            },
            Promise.resolve({
                baseFiles: {} as Record<string, string>,
                remoteBaseFiles: {} as Record<string, string>
            })
        );
        return {
            schemaVersion: 2,
            lastSyncedCommit: storedState.lastSyncedCommit,
            ...baselines
        };
    }

    private async migrateLegacyBaseline(path: string, oldSha: string): Promise<{ localHash: string; remoteSha: string }> {
        if (!isSha1(oldSha)) {
            throw new Error(`Cannot migrate v1 sync state: invalid Git blob SHA for "${path}".`);
        }
        try {
            const bytes = await this.remote.getBlobBytes(oldSha);
            return {
                localHash: await hashBytes(bytes),
                remoteSha: oldSha.toLowerCase()
            };
        } catch {
            throw new Error(
                `Cannot migrate v1 sync state: baseline content for "${path}" could not be recovered from GitHub. ` +
                'Sync stopped before changing vault files; restore the referenced Git blob and retry.'
            );
        }
    }

    private async getPathAction(
        baseHash: string | undefined,
        baseRemoteHash: string | undefined,
        localFile: LocalFile | undefined,
        remoteFile: RemoteFile | undefined,
        remoteContent: Map<string, Uint8Array>
    ): Promise<SyncActionType> {
        if (localFile && remoteFile) {
            return this.getExistingPathAction(baseHash, baseRemoteHash, localFile, remoteFile, remoteContent);
        }
        if (localFile) {
            if (!baseHash) return 'UPLOAD';
            return localFile.hash === baseHash ? 'DELETE_LOCAL' : 'UPLOAD';
        }
        if (remoteFile) {
            if (!baseHash) return 'DOWNLOAD';
            return remoteFile.sha === baseRemoteHash ? 'DELETE_REMOTE' : 'DOWNLOAD';
        }
        return 'NOOP';
    }

    private async getExistingPathAction(
        baseHash: string | undefined,
        baseRemoteHash: string | undefined,
        localFile: LocalFile,
        remoteFile: RemoteFile,
        remoteContent: Map<string, Uint8Array>
    ): Promise<SyncActionType> {
        if (!baseHash) return this.compareCandidate(localFile, remoteFile, remoteContent);
        const localChanged = localFile.hash !== baseHash;
        const remoteChanged = remoteFile.sha !== baseRemoteHash;
        if (!localChanged && !remoteChanged) return 'NOOP';
        if (localChanged && !remoteChanged) return 'UPLOAD';
        if (!localChanged && remoteChanged) return 'DOWNLOAD';
        return this.compareCandidate(localFile, remoteFile, remoteContent);
    }

    private async reconcile(
        baseState: SyncState,
        local: LocalFile[],
        remote: RemoteFile[],
        remoteContent: Map<string, Uint8Array>
    ): Promise<FileSyncPlan[]> {
        const localMap = new Map(local.map(file => [file.path, file]));
        const remoteMap = new Map(remote.map(file => [file.path, file]));
        const customExcludes = this.local.getCustomExcludes ? this.local.getCustomExcludes() : [];
        const allPaths = [...new Set([
            ...localMap.keys(),
            ...remoteMap.keys(),
            ...Object.keys(baseState.baseFiles)
        ])].filter(path => !isIgnoredPath(path, customExcludes));

        return Promise.all(allPaths.map(async path => {
            const localFile = localMap.get(path);
            const remoteFile = remoteMap.get(path);
            const baseHash = baseState.baseFiles[path];
            const baseRemoteHash = baseState.remoteBaseFiles?.[path];
            const action = await this.getPathAction(
                baseHash,
                baseRemoteHash,
                localFile,
                remoteFile,
                remoteContent
            );
            return {
                path,
                action,
                localHash: localFile?.hash,
                baseHash,
                baseRemoteHash,
                remoteSha: remoteFile?.sha
            };
        }));
    }

    private async compareCandidate(
        localFile: LocalFile,
        remoteFile: RemoteFile,
        remoteContent: Map<string, Uint8Array>
    ): Promise<SyncActionType> {
        const bytes = await this.remote.getBlobBytes(remoteFile.sha);
        remoteContent.set(localFile.path, bytes);
        return (await hashBytes(bytes)) === localFile.hash ? 'NOOP' : 'CONFLICT';
    }

    public async executeSync(onProgress?: (msg: string) => void): Promise<void> {
        // Step 1: Calculate plan
        onProgress?.('Scanning diffs...');
        const { plan, remoteHead, localMap, remoteTree, remoteContent } = await this.calculatePlan();

        // Step 2: Handle Conflicts & Downloads
        const newBaseFiles: Record<string, string> = {};
        const treeChanges: GitTreeItem[] = [];
        const processingState: SyncProcessingState = {
            newBaseFiles,
            treeChanges,
            hasUploadsOrDeletes: false,
            remoteContent
        };

        const actionItems = plan.filter(p => p.action !== 'NOOP');
        onProgress?.(`Processing ${actionItems.length} changes...`);

        await plan.reduce(
            (sequence, item) => sequence.then(() => this.processPlanItem(item, localMap, processingState, onProgress)),
            Promise.resolve()
        );

        let newCommit = remoteHead;
        let finalRemoteTree = remoteTree;

        // Step 3: Remote Atomic Commit
        if (processingState.hasUploadsOrDeletes) {
            const latestRemoteHead = await this.remote.getHeadCommit(this.branch);
            if (latestRemoteHead !== remoteHead) {
                throw new Error("Remote race detected: branch moved during sync. Please retry.");
            }


            // Chunk tree changes into batches of 500 to keep payload well within GitHub limits
            const BATCH_SIZE = 500;
            let currentTreeSha = remoteHead;
            const totalBatches = Math.ceil(treeChanges.length / BATCH_SIZE);
            const batches = Array.from(
                { length: totalBatches },
                (_, index) => treeChanges.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)
            );
            currentTreeSha = await batches.reduce(async (sequence, batch, index) => {
                const baseTreeSha = await sequence;
                onProgress?.(`Uploading batch ${index + 1}/${totalBatches} (${batch.length} files)...`);
                return this.remote.createTree(baseTreeSha, batch);
            }, Promise.resolve(currentTreeSha));

            onProgress?.('Creating commit...');
            const date = new Date().toISOString();
            const message = `Vault sync · Ray Vault Sync · ${date}`;
            newCommit = await this.remote.createCommit(message, currentTreeSha, [remoteHead]);
            
            onProgress?.('Updating remote branch...');
            await this.remote.updateRef(this.branch, newCommit);

            // A created blob SHA is a Git object identifier, not a local content
            // digest. Refresh all remote baselines from the committed tree.
            finalRemoteTree = await this.remote.getTree(newCommit);
        }

        // Step 4: Update Base State
        const finalRemoteMap = new Map(finalRemoteTree.map(file => [file.path, file]));
        const remoteBaseFiles: Record<string, string> = {};
        for (const path of Object.keys(newBaseFiles)) {
            const remoteSha = finalRemoteMap.get(path)?.sha;
            if (!remoteSha) {
                throw new Error(`Cannot save sync state: remote Git blob SHA is missing for "${path}".`);
            }
            remoteBaseFiles[path] = remoteSha;
        }
        onProgress?.('Saving local sync state...');
        await this.local.saveSyncState({
            schemaVersion: 2,
            lastSyncedCommit: newCommit,
            baseFiles: newBaseFiles,
            remoteBaseFiles
        });
    }

    private getConflictPath(path: string): string {
        const dotIndex = path.lastIndexOf('.');
        const ext = dotIndex !== -1 ? path.substring(dotIndex) : '';
        const name = dotIndex !== -1 ? path.substring(0, dotIndex) : path;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `${name}.conflict-${timestamp}${ext}`;
    }

    private isBinaryPath(path: string): boolean {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        return !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(ext);
    }

    private async addLocalFileToTree(
        path: string,
        file: LocalFile,
        treeChanges: GitTreeItem[]
    ): Promise<void> {
        if (file.isBinary) {
            const sha = await this.remote.createBlob(file.binaryData!, true);
            treeChanges.push({ path, mode: '100644', type: 'blob', sha });
            return;
        }
        treeChanges.push({ path, mode: '100644', type: 'blob', content: file.content ?? '' });
    }

    private async processPlanItem(
        item: FileSyncPlan,
        localMap: Map<string, LocalFile>,
        state: SyncProcessingState,
        onProgress?: (msg: string) => void
    ): Promise<void> {
        switch (item.action) {
            case 'NOOP':
                if (item.localHash) state.newBaseFiles[item.path] = item.localHash;
                return;
            case 'DOWNLOAD': {
                onProgress?.(`Downloading ${item.path}...`);
                const isBinary = this.isBinaryPath(item.path);
                const bytes = await this.remote.getBlobBytes(item.remoteSha!);
                const content = isBinary ? bytes : decodeText(bytes);
                await this.local.writeFile(item.path, content, isBinary);
                state.newBaseFiles[item.path] = await hashBytes(bytes);
                return;
            }
            case 'UPLOAD': {
                const localFile = localMap.get(item.path) || await this.local.readFile(item.path);
                if (localFile.isBinary) onProgress?.(`Uploading binary ${item.path}...`);
                await this.addLocalFileToTree(item.path, localFile, state.treeChanges);
                state.newBaseFiles[item.path] = item.localHash!;
                state.hasUploadsOrDeletes = true;
                return;
            }
            case 'DELETE_LOCAL':
                await this.local.deleteFile(item.path);
                return;
            case 'DELETE_REMOTE':
                state.treeChanges.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
                state.hasUploadsOrDeletes = true;
                return;
            case 'CONFLICT':
                await this.processConflict(item, localMap, state);
        }
    }

    private async processConflict(
        item: FileSyncPlan,
        localMap: Map<string, LocalFile>,
        state: SyncProcessingState
    ): Promise<void> {
        if (item.remoteSha) {
            const conflictPath = this.getConflictPath(item.path);
            const isBinary = this.isBinaryPath(item.path);
            const remoteBytes = state.remoteContent.get(item.path) ??
                await this.remote.getBlobBytes(item.remoteSha);
            state.remoteContent.set(item.path, remoteBytes);
            const remoteContent = isBinary ? remoteBytes : decodeText(remoteBytes);
            await this.local.writeFile(conflictPath, remoteContent, isBinary);
            const localFile = localMap.get(item.path) || await this.local.readFile(item.path);
            await this.addLocalFileToTree(item.path, localFile, state.treeChanges);

            if (isBinary) {
                const conflictSha = await this.remote.createBlob(remoteBytes, true);
                state.treeChanges.push({ path: conflictPath, mode: '100644', type: 'blob', sha: conflictSha });
            } else {
                state.treeChanges.push({
                    path: conflictPath,
                    mode: '100644',
                    type: 'blob',
                    content: remoteContent as string
                });
            }

            state.newBaseFiles[item.path] = item.localHash!;
            state.newBaseFiles[conflictPath] = await hashBytes(remoteBytes);
            state.hasUploadsOrDeletes = true;
        }
    }
}
