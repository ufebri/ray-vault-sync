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
});
