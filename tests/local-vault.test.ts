import { TFile } from 'obsidian';
import { LocalVault } from '../src/local-vault';

describe('LocalVault content hashes', () => {
    test('uses SHA-256 of raw content bytes, without Git blob framing', async () => {
        const content = new TextEncoder().encode('hello world\n');
        const app = {
            vault: {
                getAbstractFileByPath: () => null,
                adapter: {
                    readBinary: async () => content.buffer
                }
            }
        };
        const vault = new LocalVault(app as never);

        await expect(vault.readFile('hello.txt')).resolves.toMatchObject({
            hash: 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447',
            content: 'hello world\n',
            isBinary: false
        });
    });

    describe('LocalVault file writes', () => {
        test('creates parent directories in order before writing a new file', async () => {
            const operations: string[] = [];
            const app = {
                vault: {
                    getAbstractFileByPath: () => null,
                    adapter: {
                        exists: async () => false,
                        readBinary: async () => new ArrayBuffer(0),
                        write: async (path: string) => operations.push(`write:${path}`)
                    },
                    createFolder: async (path: string) => operations.push(`folder:${path}`),
                    create: async (path: string) => operations.push(`file:${path}`)
                }
            };
            const vault = new LocalVault(app as never);

            await vault.writeFile('one/two/note.md', 'content', false);

            expect(operations).toEqual([
                'folder:one',
                'folder:one/two',
                'file:one/two/note.md'
            ]);
        });

        test('writes existing text and binary files through Obsidian APIs', async () => {
            const textFile = Object.assign(new TFile(), { extension: 'md' });
            const binaryFile = Object.assign(new TFile(), { extension: 'png' });
            const modify = jest.fn();
            const modifyBinary = jest.fn();
            const app = {
                vault: {
                    configDir: '.obsidian',
                    getAbstractFileByPath: jest.fn(path => path === 'text.md' ? textFile : binaryFile),
                    adapter: { exists: jest.fn().mockResolvedValue(true) },
                    modify,
                    modifyBinary
                }
            };
            const vault = new LocalVault(app as never);

            await vault.writeFile('text.md', 'updated', false);
            await vault.writeFile('image.png', new Uint8Array([1, 2, 3]), true);

            expect(modify).toHaveBeenCalledWith(textFile, 'updated');
            expect(modifyBinary).toHaveBeenCalledWith(binaryFile, new Uint8Array([1, 2, 3]).buffer);
        });

        test('recovers from races where folders or files already exist', async () => {
            const operations: string[] = [];
            const app = {
                vault: {
                    configDir: '.obsidian',
                    getAbstractFileByPath: () => null,
                    adapter: {
                        exists: async () => false,
                        write: async (path: string) => operations.push(`write:${path}`)
                    },
                    createFolder: async (path: string) => {
                        if (path === 'folder') throw new Error('Folder already exists');
                    },
                    create: async () => { throw new Error('File already exists'); }
                }
            };
            const vault = new LocalVault(app as never);

            await expect(vault.writeFile('folder/note.md', 'content', false)).resolves.toBeUndefined();
            expect(operations).toEqual(['write:folder/note.md']);
        });
    });

    test('enumerates supported text and binary files while excluding ignored paths', async () => {
        const files = [
            { path: 'notes.md', extension: 'md' },
            { path: 'images/photo.png', extension: 'PNG' },
            { path: '.obsidian/config', extension: 'json' },
            { path: 'private/secret.md', extension: 'md' }
        ];
        const bytes = new TextEncoder().encode('note');
        const app = {
            vault: {
                configDir: '.obsidian',
                getFiles: () => files,
                readBinary: async () => bytes.buffer
            }
        };
        const vault = new LocalVault(app as never, 'private');

        await expect(vault.getFiles()).resolves.toMatchObject([
            { path: 'notes.md', content: 'note', isBinary: false },
            { path: 'images/photo.png', binaryData: bytes, isBinary: true }
        ]);
    });

    test('reads indexed files as binary and recognizes fallback text extensions', async () => {
        const image = Object.assign(new TFile(), { extension: 'png' });
        const imageBytes = new Uint8Array([0, 255]);
        const textBytes = new TextEncoder().encode('yaml: true');
        const app = {
            vault: {
                configDir: '.obsidian',
                getAbstractFileByPath: (path: string) => path === 'image.png' ? image : null,
                readBinary: async () => imageBytes.buffer,
                adapter: { readBinary: async () => textBytes }
            }
        };
        const vault = new LocalVault(app as never);

        await expect(vault.readFile('image.png')).resolves.toMatchObject({
            isBinary: true,
            binaryData: imageBytes
        });
        await expect(vault.readFile('settings.yaml')).resolves.toMatchObject({
            isBinary: false,
            content: 'yaml: true'
        });
    });

    test('deletes and renames indexed files with Obsidian and unindexed files with the adapter', async () => {
        const file = Object.assign(new TFile(), { extension: 'md' });
        const trashFile = jest.fn();
        const rename = jest.fn();
        const adapter = {
            exists: jest.fn().mockResolvedValue(true),
            trashSystem: jest.fn(),
            rename: jest.fn()
        };
        const app = {
            fileManager: { trashFile },
            vault: {
                configDir: '.obsidian',
                getAbstractFileByPath: (path: string) => path === 'indexed.md' ? file : null,
                adapter,
                rename
            }
        };
        const vault = new LocalVault(app as never);

        await vault.deleteFile('indexed.md');
        await vault.deleteFile('unindexed.md');
        await vault.renameFile('indexed.md', 'renamed.md');
        await vault.renameFile('unindexed.md', 'adapter-renamed.md');

        expect(trashFile).toHaveBeenCalledWith(file);
        expect(adapter.trashSystem).toHaveBeenCalledWith('unindexed.md');
        expect(rename).toHaveBeenCalledWith(file, 'renamed.md');
        expect(adapter.rename).toHaveBeenCalledWith('unindexed.md', 'adapter-renamed.md');
    });

    test('reads legacy state and persists the current schema in plugin storage', async () => {
        const legacyState = JSON.stringify({ schemaVersion: 1, lastSyncedCommit: 'old-commit' });
        const writes: string[] = [];
        const existing = new Set(['.obsidian', '.obsidian/plugins']);
        const adapter = {
            exists: async (path: string) => existing.has(path) || path.endsWith('raylabs-vault-sync/sync-state.json'),
            read: async () => legacyState,
            mkdir: async (path: string) => { existing.add(path); },
            write: async (path: string, content: string) => writes.push(`${path}:${content}`)
        };
        const vault = new LocalVault({ vault: { configDir: '.obsidian', adapter } } as never);

        await expect(vault.getSyncState()).resolves.toEqual({
            schemaVersion: 1,
            lastSyncedCommit: 'old-commit'
        });
        const state = { schemaVersion: 1 as const, lastSyncedCommit: 'new-commit', baseFiles: {} };
        await vault.saveSyncState(state);

        expect(state.schemaVersion).toBe(2);
        expect(writes[0]).toContain('.obsidian/plugins/ray-vault-sync/sync-state.json');
        expect(writes[0]).toContain('"schemaVersion": 2');
    });
});
