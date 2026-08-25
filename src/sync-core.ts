import { ILocalVault, IGitHubClient, LocalFile, RemoteFile, SyncState, GitTreeItem } from './interfaces';

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

export class SyncEngine {
    constructor(
        private local: ILocalVault,
        private remote: IGitHubClient,
        private branch: string = 'main'
    ) {}

    public async calculatePlan(): Promise<{ plan: FileSyncPlan[], remoteHead: string, baseState: SyncState }> {
        const remoteHead = await this.remote.getHeadCommit(this.branch);
        const remoteTree = await this.remote.getTree(remoteHead);
        const localFiles = await this.local.getFiles();
        
        let baseState = await this.local.getSyncState();
        if (!baseState) {
            baseState = { schemaVersion: 1, lastSyncedCommit: '', baseFiles: {} };
        }

        const plan = this.reconcile(baseState.baseFiles, localFiles, remoteTree);
        return { plan, remoteHead, baseState };
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

        for (const path of allPaths) {
            if (path.startsWith('.') || path.includes('/.')) continue; // Ignore hidden files/folders globally

            const bHash = base[path];
            const lHash = localMap.get(path)?.hash;
            const rHash = remoteMap.get(path)?.hash;
            const rSha = remoteMap.get(path)?.sha;

            let action: SyncActionType = 'NOOP';

            // Same on both sides
            if (lHash === rHash) {
                action = 'NOOP';
            }
            // Local changed, Remote unchanged
            else if (lHash && rHash === bHash) {
                action = 'UPLOAD';
            }
            // Remote changed, Local unchanged
            else if (rHash && lHash === bHash) {
                action = 'DOWNLOAD';
            }
            // Created on Local only
            else if (lHash && !rHash && !bHash) {
                action = 'UPLOAD';
            }
            // Created on Remote only
            else if (!lHash && rHash && !bHash) {
                action = 'DOWNLOAD';
            }
            // Deleted locally, unchanged remotely
            else if (!lHash && bHash && rHash === bHash) {
                action = 'DELETE_REMOTE';
            }
            // Deleted remotely, unchanged locally
            else if (!rHash && bHash && lHash === bHash) {
                action = 'DELETE_LOCAL';
            }
            // Conflict / concurrent edits
            else {
                if (!lHash && !rHash) {
                    action = 'NOOP'; // Both deleted
                } else {
                    action = 'CONFLICT';
                }
            }

            plan.push({
                path,
                action,
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
        onProgress?.('Calculating diffs...');
        const { plan, remoteHead, baseState } = await this.calculatePlan();
        
        const needsAction = plan.some(p => p.action !== 'NOOP');
        if (!needsAction && remoteHead === baseState.lastSyncedCommit) {
            onProgress?.('Already up to date');
            return; // Already up to date
        }

        // Step 2: Handle Conflicts & Downloads
        const newBaseFiles: Record<string, string> = {};
        const treeChanges: GitTreeItem[] = [];
        let hasUploadsOrDeletes = false;

        const actionItems = plan.filter(p => p.action !== 'NOOP');
        let currentItem = 0;

        for (const item of plan) {
            if (item.action !== 'NOOP') {
                currentItem++;
                onProgress?.(`Processing ${currentItem}/${actionItems.length}: ${item.action}...`);
            }

            if (item.action === 'NOOP') {
                if (item.localHash) newBaseFiles[item.path] = item.localHash;
            } else if (item.action === 'DOWNLOAD') {
                const ext = item.path.split('.').pop()?.toLowerCase() || '';
                const isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(ext);
                const content = await this.remote.getBlob(item.remoteSha!, isBinary);
                await this.local.writeFile(item.path, content, isBinary);
                newBaseFiles[item.path] = item.remoteHash!;
            } else if (item.action === 'UPLOAD') {
                const localFile = await this.local.readFile(item.path);
                const sha = await this.remote.createBlob(localFile.content || localFile.binaryData!, localFile.isBinary);
                treeChanges.push({
                    path: item.path,
                    mode: '100644',
                    type: 'blob',
                    sha: sha
                });
                newBaseFiles[item.path] = item.localHash!;
                hasUploadsOrDeletes = true;
            } else if (item.action === 'DELETE_LOCAL') {
                await this.local.deleteFile(item.path);
            } else if (item.action === 'DELETE_REMOTE') {
                treeChanges.push({
                    path: item.path,
                    mode: '100644',
                    type: 'blob',
                    sha: null
                });
                hasUploadsOrDeletes = true;
            } else if (item.action === 'CONFLICT') {
                // Strict Zero Silent Data Loss: Preserve both versions
                if (item.remoteHash && item.remoteSha) {
                    const conflictPath = this.getConflictPath(item.path);
                    const ext = item.path.split('.').pop()?.toLowerCase() || '';
                    const isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(ext);
                    
                    const remoteContent = await this.remote.getBlob(item.remoteSha, isBinary);
                    await this.local.writeFile(conflictPath, remoteContent, isBinary);
                    
                    const localFile = await this.local.readFile(item.path);
                    const sha = await this.remote.createBlob(localFile.content || localFile.binaryData!, localFile.isBinary);
                    treeChanges.push({
                        path: item.path,
                        mode: '100644',
                        type: 'blob',
                        sha: sha
                    });
                    
                    const conflictSha = await this.remote.createBlob(remoteContent, isBinary);
                    treeChanges.push({
                        path: conflictPath,
                        mode: '100644',
                        type: 'blob',
                        sha: conflictSha
                    });

                    newBaseFiles[item.path] = item.localHash!;
                    newBaseFiles[conflictPath] = item.remoteHash;
                    hasUploadsOrDeletes = true;
                } else if (item.localHash && !item.remoteHash) {
                    // Local edit while deleted remotely: re-upload local
                    const localFile = await this.local.readFile(item.path);
                    const sha = await this.remote.createBlob(localFile.content || localFile.binaryData!, localFile.isBinary);
                    treeChanges.push({
                        path: item.path,
                        mode: '100644',
                        type: 'blob',
                        sha: sha
                    });
                    newBaseFiles[item.path] = item.localHash;
                    hasUploadsOrDeletes = true;
                }
            }
        }

        let newCommit = remoteHead;
        
        // Step 3: Remote Atomic Commit
        if (hasUploadsOrDeletes) {
            onProgress?.('Committing changes to GitHub...');
            const latestRemoteHead = await this.remote.getHeadCommit(this.branch);
            if (latestRemoteHead !== remoteHead) {
                throw new Error("Remote race detected: branch moved during sync. Please retry.");
            }

            const newTreeSha = await this.remote.createTree(remoteHead, treeChanges);
            const date = new Date().toISOString();
            const message = `Vault sync · Ray Vault Sync · ${date}`;
            newCommit = await this.remote.createCommit(message, newTreeSha, [remoteHead]);
            
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
}
