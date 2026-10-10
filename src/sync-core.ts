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
    remoteHash?: string;
    baseHash?: string;
    remoteSha?: string;
}

function getSyncAction(
    baseHash: string | undefined,
    localHash: string | undefined,
    remoteHash: string | undefined
): SyncActionType {
    if (localHash === remoteHash) return 'NOOP';
    if (localHash && remoteHash === baseHash) return 'UPLOAD';
    if (remoteHash && localHash === baseHash) return 'DOWNLOAD';
    if (localHash && !remoteHash && !baseHash) return 'UPLOAD';
    if (!localHash && remoteHash && !baseHash) return 'DOWNLOAD';
    if (!localHash && baseHash && remoteHash === baseHash) return 'DELETE_REMOTE';
    if (!remoteHash && baseHash && localHash === baseHash) return 'DELETE_LOCAL';
    if (!localHash && !remoteHash) return 'NOOP';
    return 'CONFLICT';
}

interface SyncProcessingState {
    newBaseFiles: Record<string, string>;
    treeChanges: GitTreeItem[];
    hasUploadsOrDeletes: boolean;
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
        localMap: Map<string, LocalFile>
    }> {
        const remoteHead = await this.remote.getHeadCommit(this.branch);
        const remoteTree = await this.remote.getTree(remoteHead);
        const localFiles = await this.local.getFiles();
        
        let baseState = await this.local.getSyncState();
        baseState ??= { schemaVersion: 1, lastSyncedCommit: '', baseFiles: {} };

        const plan = this.reconcile(baseState.baseFiles, localFiles, remoteTree);
        const localMap = new Map<string, LocalFile>();
        for (const lf of localFiles) localMap.set(lf.path, lf);

        return { plan, remoteHead, baseState, localMap };
    }

    private reconcile(
        base: Record<string, string>, 
        local: LocalFile[], 
        remote: RemoteFile[]
    ): FileSyncPlan[] {
        const localMap = new Map<string, LocalFile>();
        for (const lf of local) localMap.set(lf.path, lf);

        const remoteMap = new Map<string, RemoteFile>();
        for (const rf of remote) remoteMap.set(rf.path, rf);

        const allPaths = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(base)]);
        const plan: FileSyncPlan[] = [];

        const customExcludes = this.local.getCustomExcludes ? this.local.getCustomExcludes() : [];

        for (const path of allPaths) {
            if (isIgnoredPath(path, customExcludes)) continue; // Ignore hidden files, node_modules, and custom user excludes

            const bHash = base[path];
            const lHash = localMap.get(path)?.hash;
            const rHash = remoteMap.get(path)?.hash;
            const rSha = remoteMap.get(path)?.sha;

            plan.push({
                path,
                action: getSyncAction(bHash, lHash, rHash),
                localHash: lHash,
                remoteHash: rHash,
                baseHash: bHash,
                remoteSha: rSha
            });
        }

        return plan;
    }

    public async executeSync(onProgress?: (msg: string) => void): Promise<void> {
        // Step 1: Calculate plan
        onProgress?.('Scanning diffs...');
        const { plan, remoteHead, baseState, localMap } = await this.calculatePlan();
        
        const needsAction = plan.some(p => p.action !== 'NOOP');
        if (!needsAction && remoteHead === baseState.lastSyncedCommit) {
            onProgress?.('Already up to date');
            return; // Already up to date
        }

        // Step 2: Handle Conflicts & Downloads
        const newBaseFiles: Record<string, string> = {};
        const treeChanges: GitTreeItem[] = [];
        const processingState: SyncProcessingState = {
            newBaseFiles,
            treeChanges,
            hasUploadsOrDeletes: false
        };

        const actionItems = plan.filter(p => p.action !== 'NOOP');
        onProgress?.(`Processing ${actionItems.length} changes...`);

        await plan.reduce(
            (sequence, item) => sequence.then(() => this.processPlanItem(item, localMap, processingState, onProgress)),
            Promise.resolve()
        );

        let newCommit = remoteHead;
        
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

            for (let i = 0; i < treeChanges.length; i += BATCH_SIZE) {
                const batch = treeChanges.slice(i, i + BATCH_SIZE);
                const batchNum = Math.floor(i / BATCH_SIZE) + 1;
                onProgress?.(`Uploading batch ${batchNum}/${totalBatches} (${batch.length} files)...`);
                currentTreeSha = await this.remote.createTree(currentTreeSha, batch);
            }

            onProgress?.('Creating commit...');
            const date = new Date().toISOString();
            const message = `Vault sync · Ray Vault Sync · ${date}`;
            newCommit = await this.remote.createCommit(message, currentTreeSha, [remoteHead]);
            
            onProgress?.('Updating remote branch...');
            await this.remote.updateRef(this.branch, newCommit);
        }

        // Step 4: Update Base State
        onProgress?.('Saving local sync state...');
        await this.local.saveSyncState({
            schemaVersion: 1,
            lastSyncedCommit: newCommit,
            baseFiles: newBaseFiles
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
                const content = await this.remote.getBlob(item.remoteSha!, isBinary);
                await this.local.writeFile(item.path, content, isBinary);
                state.newBaseFiles[item.path] = item.remoteHash!;
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
        if (item.remoteHash && item.remoteSha) {
            const conflictPath = this.getConflictPath(item.path);
            const isBinary = this.isBinaryPath(item.path);
            const remoteContent = await this.remote.getBlob(item.remoteSha, isBinary);
            await this.local.writeFile(conflictPath, remoteContent, isBinary);
            const localFile = localMap.get(item.path) || await this.local.readFile(item.path);
            await this.addLocalFileToTree(item.path, localFile, state.treeChanges);

            if (isBinary) {
                const conflictSha = await this.remote.createBlob(remoteContent, true);
                state.treeChanges.push({ path: conflictPath, mode: '100644', type: 'blob', sha: conflictSha });
            } else {
                state.treeChanges.push({
                    path: conflictPath,
                    mode: '100644',
                    type: 'blob',
                    content: typeof remoteContent === 'string' ? remoteContent : ''
                });
            }

            state.newBaseFiles[item.path] = item.localHash!;
            state.newBaseFiles[conflictPath] = item.remoteHash;
            state.hasUploadsOrDeletes = true;
            return;
        }
        if (item.localHash && !item.remoteHash) {
            const localFile = localMap.get(item.path) || await this.local.readFile(item.path);
            await this.addLocalFileToTree(item.path, localFile, state.treeChanges);
            state.newBaseFiles[item.path] = item.localHash;
            state.hasUploadsOrDeletes = true;
        }
    }
}
