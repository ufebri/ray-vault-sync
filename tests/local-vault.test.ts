import { LocalVault } from '../src/local-vault';

describe('LocalVault GitHub blob hashes', () => {
    test('uses Git blob framing for content hashes', async () => {
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
            hash: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
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
    });
});
