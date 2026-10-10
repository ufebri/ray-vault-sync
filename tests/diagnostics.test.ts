import { Notice } from 'obsidian';
import { runDiagnostics } from '../src/diagnostics';
import { LocalVault } from '../src/local-vault';
import { GitHubClient } from '../src/github-client';
import { SyncEngine } from '../src/sync-core';
import { ErrorLogManager } from '../src/error-log';

jest.mock('../src/local-vault');
jest.mock('../src/github-client');
jest.mock('../src/sync-core');
jest.mock('../src/error-log');

const localVaultMock = jest.mocked(LocalVault);
const githubClientMock = jest.mocked(GitHubClient);
const syncEngineMock = jest.mocked(SyncEngine);
const errorLogMock = jest.mocked(ErrorLogManager);

describe('runDiagnostics', () => {
    let reportContent: string;
    let mockLocalVault: { getSyncState: jest.Mock; getFiles: jest.Mock; writeFile: jest.Mock };
    let mockGitHub: { getHeadCommit: jest.Mock; getTree: jest.Mock };
    let mockEngine: { calculatePlan: jest.Mock };
    let mockErrorLog: { formatRecent: jest.Mock };
    let app: {
        vault: { getAbstractFileByPath: jest.Mock };
        workspace: { getLeaf: jest.Mock };
    };
    const settings = {
        githubToken: 'ghp_secret_token',
        repository: 'owner/repository',
        branch: 'main',
        autoSyncEnabled: true,
        autoSyncInterval: 10,
        excludedPaths: 'private'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        Notice.messages.length = 0;
        reportContent = '';
        mockLocalVault = {
            getSyncState: jest.fn().mockResolvedValue({
                schemaVersion: 2,
                lastSyncedCommit: 'commit-1'
            }),
            getFiles: jest.fn().mockResolvedValue([
                { path: 'note.md' },
                { path: 'note.conflict-copy.md' }
            ]),
            writeFile: jest.fn().mockImplementation(async (_path, content: Uint8Array) => {
                reportContent = new TextDecoder().decode(content);
            })
        };
        mockGitHub = {
            getHeadCommit: jest.fn().mockResolvedValue('commit-2'),
            getTree: jest.fn().mockResolvedValue([{ path: 'remote.md' }])
        };
        mockEngine = {
            calculatePlan: jest.fn().mockResolvedValue({
                plan: [
                    { action: 'NOOP' },
                    { action: 'UPLOAD' },
                    { action: 'DOWNLOAD' },
                    { action: 'DELETE_LOCAL' },
                    { action: 'DELETE_REMOTE' },
                    { action: 'CONFLICT' }
                ]
            })
        };
        mockErrorLog = { formatRecent: jest.fn().mockResolvedValue('Recent safe error') };
        localVaultMock.mockImplementation((() => mockLocalVault) as never);
        githubClientMock.mockImplementation((() => mockGitHub) as never);
        syncEngineMock.mockImplementation((() => mockEngine) as never);
        errorLogMock.mockImplementation((() => mockErrorLog) as never);
        app = {
            vault: { getAbstractFileByPath: jest.fn().mockReturnValue({ extension: 'md' }) },
            workspace: { getLeaf: jest.fn().mockReturnValue({ openFile: jest.fn() }) }
        };
    });

    test('writes a complete report, opens it, and masks the configured token', async () => {
        await runDiagnostics(app as never, settings as never);

        expect(reportContent).toContain('Repository: `owner/repository`');
        expect(reportContent).toContain('Token: `ghp_...oken`');
        expect(reportContent).not.toContain(settings.githubToken);
        expect(reportContent).toContain('Active Conflict Copies: 1');
        expect(reportContent).toContain('Remote Tree Listing: Accessible (1 files tracked)');
        expect(reportContent).toContain('Potential Conflicts: 1');
        expect(mockErrorLog.formatRecent).toHaveBeenCalledWith(10);
        expect(app.workspace.getLeaf).toHaveBeenCalledWith(true);
        expect(Notice.messages).toEqual([
            'Ray Vault Sync: Running diagnostics...',
            'Ray Vault Sync: Diagnostics complete! Report opened.'
        ]);
    });

    test('skips the plan preview if local or GitHub checks fail and still writes a report', async () => {
        mockLocalVault.getSyncState.mockRejectedValueOnce(new Error('local disk unavailable'));
        mockGitHub.getHeadCommit.mockRejectedValueOnce('remote unavailable');

        await runDiagnostics(app as never, { ...settings, githubToken: '', repository: '' } as never);

        expect(mockEngine.calculatePlan).not.toHaveBeenCalled();
        expect(reportContent).toContain('Local Vault Error: local disk unavailable');
        expect(reportContent).toContain('GitHub Connection Error: GitHub token is empty');
        expect(reportContent).not.toContain('Synchronization Plan Preview');
        expect(Notice.messages.at(-1)).toBe('Ray Vault Sync: Diagnostics complete! Report opened.');
    });

    test('reports file-write failures to the user', async () => {
        mockLocalVault.writeFile.mockRejectedValueOnce(new Error('vault is read-only'));

        await runDiagnostics(app as never, settings as never);

        expect(Notice.messages.at(-1)).toBe(
            'Ray Vault Sync: Diagnostics failed to write report. vault is read-only'
        );
    });
});
