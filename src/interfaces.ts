export interface LocalFile {
    path: string;
    hash: string; // SHA-256 digest of raw file bytes
    content?: string; // For text files
    binaryData?: Uint8Array; // For binary files
    isBinary: boolean;
}

export interface RemoteFile {
    path: string;
    sha: string; // GitHub Git blob SHA-1; never used as a local content digest
}

export interface SyncState {
    schemaVersion?: number;
    lastSyncedCommit: string;
    baseFiles: Record<string, string>; // schema v2: path -> local SHA-256 baseline
    remoteBaseFiles?: Record<string, string>; // schema v2: path -> GitHub blob SHA-1 baseline
}

export interface ILocalVault {
    getFiles(): Promise<LocalFile[]>;
    readFile(path: string): Promise<LocalFile>;
    writeFile(path: string, content: string | Uint8Array, isBinary: boolean): Promise<void>;
    deleteFile(path: string): Promise<void>;
    renameFile(oldPath: string, newPath: string): Promise<void>;
    getSyncState(): Promise<SyncState | null>;
    saveSyncState(state: SyncState): Promise<void>;
    getCustomExcludes?(): string[];
}

export interface GitTreeItem {
    path: string;
    mode: string;
    type: string;
    sha?: string | null;
    content?: string;
}

export interface IGitHubClient {
    getHeadCommit(branch: string): Promise<string>;
    getTree(commitSha: string): Promise<RemoteFile[]>;
    getBlob(sha: string, isBinary: boolean): Promise<string | Uint8Array>;
    getBlobBytes(sha: string): Promise<Uint8Array>;
    createTree(baseTreeSha: string, tree: GitTreeItem[]): Promise<string>;
    createCommit(message: string, treeSha: string, parents: string[]): Promise<string>;
    updateRef(branch: string, commitSha: string, force?: boolean): Promise<void>;
    createBlob(content: string | Uint8Array, isBinary: boolean): Promise<string>;
}
