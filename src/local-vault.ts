import { App, TFile } from 'obsidian';
import { ILocalVault, LocalFile, SyncState } from './interfaces';

export class LocalVault implements ILocalVault {
    private syncStatePath = '.obsidian/plugins/ray-vault-sync/sync-state.json';
    private legacySyncStatePath = '.obsidian/plugins/raylabs-vault-sync/sync-state.json';

    constructor(private app: App) {}

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

    public async getFiles(): Promise<LocalFile[]> {
        const allFiles = this.app.vault.getFiles();
        const localFiles: LocalFile[] = [];

        for (const file of allFiles) {
            if (file.path.startsWith('.git/') || file.path.includes('sync-state.json')) continue;
            
            const content = await this.app.vault.readBinary(file);
            const hash = await this.getGithubBlobSha(content);
            const isBinary = !['md', 'json', 'txt', 'csv', 'yaml', 'yml'].includes(file.extension.toLowerCase());

            localFiles.push({
                path: file.path,
                hash,
                isBinary
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
            buffer = data.buffer;
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
        const parts = path.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length - 1; i++) {
            currentPath += (currentPath ? '/' : '') + parts[i];
            const exists = await this.app.vault.adapter.exists(currentPath);
            if (!exists) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (e: any) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    if (!errMsg.includes('Folder already exists')) {
                        throw e;
                    }
                }
            }
        }

        const file = this.app.vault.getAbstractFileByPath(path);
        const existsOnDisk = await this.app.vault.adapter.exists(path);
        
        if (file instanceof TFile) {
            if (isBinary) {
                await this.app.vault.modifyBinary(file, (content as Uint8Array).buffer);
            } else {
                await this.app.vault.modify(file, content as string);
            }
        } else if (existsOnDisk) {
            if (isBinary) {
                await this.app.vault.adapter.writeBinary(path, content as Uint8Array);
            } else {
                await this.app.vault.adapter.write(path, content as string);
            }
        } else {
            try {
                if (isBinary) {
                    await this.app.vault.createBinary(path, (content as Uint8Array).buffer);
                } else {
                    await this.app.vault.create(path, content as string);
                }
            } catch (e: any) {
                const errMsg = e instanceof Error ? e.message : String(e);
                if (errMsg.includes('File already exists')) {
                    if (isBinary) {
                        await this.app.vault.adapter.writeBinary(path, content as Uint8Array);
                    } else {
                        await this.app.vault.adapter.write(path, content as string);
                    }
                } else {
                    throw e;
                }
            }
        }
    }

    public async deleteFile(path: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.app.vault.trash(file, false);
        } else if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.trashLocal(path);
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
            } catch (e) {}
        }

        return null;
    }

    public async saveSyncState(state: SyncState): Promise<void> {
        state.schemaVersion = 1;
        const dir = this.syncStatePath.substring(0, this.syncStatePath.lastIndexOf('/'));
        
        const parts = dir.split('/');
        let currentPath = '';
        for (let i = 0; i < parts.length; i++) {
            currentPath += (currentPath ? '/' : '') + parts[i];
            if (!(await this.app.vault.adapter.exists(currentPath))) {
                await this.app.vault.adapter.mkdir(currentPath);
            }
        }
        
        await this.app.vault.adapter.write(this.syncStatePath, JSON.stringify(state, null, 2));
    }
}
