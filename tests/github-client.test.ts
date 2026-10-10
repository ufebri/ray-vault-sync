import { requestUrl } from 'obsidian';
import { GitHubClient } from '../src/github-client';

const mockedRequest = jest.mocked(requestUrl);

function respond(status: number, json: unknown, headers: Record<string, string> = {}) {
    mockedRequest.mockResolvedValue({ status, json, headers } as never);
}

describe('GitHubClient', () => {
    let client: GitHubClient;

    beforeEach(() => {
        mockedRequest.mockReset();
        client = new GitHubClient('test-token', 'owner/repo');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { setTimeout: (callback: () => void) => callback() }
        });
    });

    test('gets a branch head and filters tree entries to blobs', async () => {
        respond(200, { object: { sha: 'commit-sha' } });
        await expect(client.getHeadCommit('main')).resolves.toBe('commit-sha');
        expect(mockedRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            url: 'https://api.github.com/repos/owner/repo/git/refs/heads/main',
            method: 'GET'
        }));

        respond(200, { tree: [
            { path: 'note.md', type: 'blob', sha: 'blob-sha' },
            { path: 'folder', type: 'tree', sha: 'tree-sha' }
        ] });
        await expect(client.getTree('commit-sha')).resolves.toEqual([
            { path: 'note.md', sha: 'blob-sha' }
        ]);
    });

    test('decodes GitHub blob bytes and text', async () => {
        respond(200, { content: 'aGVs\nbG8=' });
        await expect(client.getBlobBytes('blob-sha')).resolves.toEqual(new TextEncoder().encode('hello'));
        respond(200, { content: 'aGVs\nbG8=' });
        await expect(client.getBlob('blob-sha', false)).resolves.toBe('hello');
        respond(200, { content: 'aGVs\nbG8=' });
        await expect(client.getBlob('blob-sha', true)).resolves.toEqual(new TextEncoder().encode('hello'));
    });

    test('sends tree, commit, ref, and encoded blob mutations', async () => {
        respond(200, { sha: 'result-sha' });
        await expect(client.createTree('base-sha', [{ path: 'note.md', mode: '100644', type: 'blob', content: 'hello' }]))
            .resolves.toBe('result-sha');
        expect(mockedRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                base_tree: 'base-sha',
                tree: [{ path: 'note.md', mode: '100644', type: 'blob', content: 'hello' }]
            })
        }));

        respond(200, { sha: 'commit-sha' });
        await expect(client.createCommit('sync', 'tree-sha', ['parent-sha'])).resolves.toBe('commit-sha');
        expect(mockedRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            body: JSON.stringify({ message: 'sync', tree: 'tree-sha', parents: ['parent-sha'] })
        }));

        respond(200, {});
        await client.updateRef('main', 'commit-sha');
        expect(mockedRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ sha: 'commit-sha', force: false })
        }));

        respond(200, { sha: 'blob-sha' });
        await expect(client.createBlob('hello', false)).resolves.toBe('blob-sha');
        expect(mockedRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            body: JSON.stringify({ content: 'aGVsbG8=', encoding: 'base64' })
        }));
    });

    test.each([
        [403, { message: 'Resource not accessible by personal access token' }, {}, 'Contents: Read & write'],
        [403, { message: 'rate limit exceeded' }, { 'retry-after': '12' }, 'reset in 12s'],
        [401, { message: 'Bad credentials' }, {}, 'Invalid GitHub Token'],
        [404, { message: 'Not Found' }, {}, 'Repository not found'],
        [500, { message: 'server issue' }, {}, 'GitHub Error: server issue']
    ])('maps API error status %s to a useful message', async (status, json, headers, expected) => {
        respond(status as number, json, headers as Record<string, string>);
        await expect(client.getHeadCommit('main')).rejects.toThrow(expected as string);
    });

    test('falls back to rate-limit handling when an error body cannot be parsed', async () => {
        const response = { status: 429, headers: { 'x-ratelimit-reset': '10' } };
        Object.defineProperty(response, 'json', { get: () => { throw new Error('invalid JSON'); } });
        mockedRequest.mockResolvedValue(response as never);

        await expect(client.getHeadCommit('main')).rejects.toThrow('Rate Limit exceeded');
    });
});
