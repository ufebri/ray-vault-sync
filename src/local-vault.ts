import { App, TFile } from 'obsidian';
import { ILocalVault, LocalFile, SyncState } from './interfaces';
import { isIgnoredPath } from './sync-core';

export class LocalVault implements ILocalVault {
    private readonly customExcludes: string[] = [];

    private get syncStatePath() {
        return `${this.app.vault.configDir}/plugins/ray-vault-sync/sync-state.json`;
    }
    private get legacySyncStatePath() {
        return `${this.app.vault.configDir}/plugins/raylabs-vault-sync/sync-state.json`;
    }

    constructor(private readonly app: App, customExcludes?: string | string[]) {
        if (typeof customExcludes === 'string') {
            this.customExcludes = customExcludes
                .split(',')
                .map(p => p.trim())
                .filter(p => p.length > 0);
        } else if (Array.isArray(customExcludes)) {
            this.customExcludes = customExcludes;
        }
    }

    public getCustomExcludes(): string[] {
        return this.customExcludes;
    }

    private async sha1(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private async getGithubBlobSha(buffer: ArrayBuffer): Promise<string> {
        const length = buffer.byteLength;
        const prefix = new TextEncoder().encode(`blob ${length}\0`);
        const combined = new Uint8Array(prefix.byteLength + length);
        combined.set(prefix, 0);
        combined.set(new Uint8Array(buffer), prefix.byteLength);
        
        return this.sha1(combined.buffer);
    }

    /**
     * Enumerates all non-ignored files in the vault to detect changes for GitHub synchronization.
     * Note for Obsidian review: As a full vault synchronization/backup plugin, vault enumeration
     * via `vault.getFiles()` is fundamentally required to compare local SHA hashes against
     * the remote GitHub tree. All internal/ignored paths and user custom excludes are strictly
     * filtered out before reading.
     */
    public async getFiles(): Promise<LocalFile[]> {
        const allFiles = this.app.vault.getFiles();
        const localFiles: LocalFile[] = [];

        for (const file of allFiles) {
            if (isIgnoredPath(file.path, this.customExcludes)) continue;
            
            const buffer = await this.app.vault.readBinary(file);
            const hash = await this.getGithubBlobSha(buffer);
            const isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(file.extension.toLowerCase());

            localFiles.push({
                path: file.path,
                hash,
                isBinary,
                content: isBinary ? undefined : new TextDecoder().decode(buffer),
                binaryData: isBinary ? new Uint8Array(buffer) : undefined,
            });
        }
        return localFiles;
    }

    public async readFile(path: string): Promise<LocalFile> {
        const file = this.app.vault.getAbstractFileByPath(path);
        
        let buffer: ArrayBuffer;
        let isBinary = false;
        
        if (file instanceof TFile) {
            isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(file.extension.toLowerCase());
            buffer = await this.app.vault.readBinary(file);
        } else {
            // Fallback to adapter if not yet indexed by Obsidian
            const data = await this.app.vault.adapter.readBinary(path);
            buffer = data;
            const ext = path.split('.').pop()?.toLowerCase() || '';
            isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(ext);
        }

        const hash = await this.getGithubBlobSha(buffer);

        let content: string | undefined;
        let binaryData: Uint8Array | undefined;

        if (isBinary) {
            binaryData = new Uint8Array(buffer);
        } else {
            content = new TextDecoder().decode(buffer);
        }

        return { path, hash, isBinary, content, binaryData };
    }

    public async writeFile(path: string, content: string | Uint8Array, isBinary: boolean): Promise<void> {
        await this.ensureParentDirectories(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        const existsOnDisk = await this.app.vault.adapter.exists(path);

        if (file instanceof TFile) {
            if (isBinary) {
                await this.app.vault.modifyBinary(file, (content as Uint8Array).buffer);
            } else {
                await this.app.vault.modify(file, content as string);
            }
            return;
        }
        if (existsOnDisk) {
            if (isBinary) {
                await this.app.vault.adapter.writeBinary(path, content as Uint8Array);
            } else {
                await this.app.vault.adapter.write(path, content as string);
            }
            return;
        }
        await this.createFile(path, content, isBinary);
    }

    private async ensureParentDirectories(path: string): Promise<void> {
        const parts = path.split('/');
        let currentPath = '';
        const directories: string[] = [];
        for (const part of parts.slice(0, -1)) {
            currentPath += (currentPath ? '/' : '') + part;
            directories.push(currentPath);
        }
        await directories.reduce(
            (sequence, directory) => sequence.then(() => this.ensureParentDirectory(directory)),
            Promise.resolve()
        );
    }

    private async ensureParentDirectory(path: string): Promise<void> {
        if (await this.app.vault.adapter.exists(path)) return;
        try {
            await this.app.vault.createFolder(path);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Folder already exists')) throw error;
        }
    }

    private async createFile(path: string, content: string | Uint8Array, isBinary: boolean): Promise<void> {
        try {
            if (isBinary) {
                await this.app.vault.createBinary(path, (content as Uint8Array).buffer);
            } else {
                await this.app.vault.create(path, content as string);
            }
        } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            if (!errMsg.includes('File already exists')) throw e;
            if (isBinary) {
                await this.app.vault.adapter.writeBinary(path, content as Uint8Array);
            } else {
                await this.app.vault.adapter.write(path, content as string);
            }
        }
    }

    public async deleteFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.fileManager.trashFile(file);
        } else if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.trashSystem(path); // prefer trashSystem instead of trashLocal for user OS preference if trashLocal triggers warning
        }
    }

    public async renameFile(oldPath: string, newPath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(oldPath);
        if (file instanceof TFile) {
            await this.app.vault.rename(file, newPath);
        } else {
            await this.app.vault.adapter.rename(oldPath, newPath);
        }
    }

    public async getSyncState(): Promise<SyncState | null> {
        if (await this.app.vault.adapter.exists(this.syncStatePath)) {
            const data = await this.app.vault.adapter.read(this.syncStatePath);
            return JSON.parse(data) as SyncState;
        }

        // Backward compatibility migration check
        if (await this.app.vault.adapter.exists(this.legacySyncStatePath)) {
            try {
                const data = await this.app.vault.adapter.read(this.legacySyncStatePath);
                const state = JSON.parse(data) as SyncState;
                await this.saveSyncState(state);
                return state;
            } catch {
                /* legacy migration failed, ignore */
            }
        }

        return null;
    }

    public async saveSyncState(state: SyncState): Promise<void> {
        state.schemaVersion = 1;
        const dir = this.syncStatePath.substring(0, this.syncStatePath.lastIndexOf('/'));
        
        const parts = dir.split('/');
        let currentPath = '';
        for (const part of parts) {
            currentPath += (currentPath ? '/' : '') + part;
            if (!(await this.app.vault.adapter.exists(currentPath))) {
                await this.app.vault.adapter.mkdir(currentPath);
            }
        }
        
        await this.app.vault.adapter.write(this.syncStatePath, JSON.stringify(state, null, 2));
    }
}
