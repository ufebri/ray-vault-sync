import { Notice } from 'obsidian';
import RayVaultSyncPlugin from '../src/main';
import { LocalVault } from '../src/local-vault';
import { GitHubClient } from '../src/github-client';
import { SyncEngine, SyncSafetyError } from '../src/sync-core';
import { MobileSyncWidget } from '../src/mobile-widget';

jest.mock('../src/local-vault');
jest.mock('../src/github-client');
jest.mock('../src/sync-core', () => ({
    ...jest.requireActual('../src/sync-core'),
    SyncEngine: jest.fn()
}));
jest.mock('../src/diagnostics', () => ({ runDiagnostics: jest.fn() }));
jest.mock('../src/mobile-widget', () => ({
    ...jest.requireActual('../src/mobile-widget'),
    MobileSyncWidget: jest.fn().mockImplementation(() => ({
        mount: jest.fn(),
        destroy: jest.fn(),
        setError: jest.fn(),
        setSyncing: jest.fn(),
        setSuccess: jest.fn(),
        updateState: jest.fn()
    }))
}));

const localVaultMock = jest.mocked(LocalVault);
const githubClientMock = jest.mocked(GitHubClient);
const syncEngineMock = jest.mocked(SyncEngine);

describe('RayVaultSyncPlugin sync lifecycle', () => {
    let plugin: RayVaultSyncPlugin;
    let mockEngine: { executeSync: jest.Mock };
    let statusBar: { setText: jest.Mock };
    let errorLog: { log: jest.Mock };

    beforeEach(() => {
        jest.clearAllMocks();
        Notice.messages.length = 0;
        mockEngine = { executeSync: jest.fn().mockResolvedValue(undefined) };
        localVaultMock.mockImplementation((() => ({
            getSyncState: jest.fn().mockResolvedValue(null)
        })) as never);
        githubClientMock.mockImplementation((() => ({})) as never);
        syncEngineMock.mockImplementation((() => mockEngine) as never);
        plugin = new RayVaultSyncPlugin();
        statusBar = { setText: jest.fn() };
        errorLog = { log: jest.fn().mockResolvedValue(undefined) };
        Object.assign(plugin, {
            app: {},
            settings: {
                githubToken: 'token',
                repository: 'owner/repo',
                branch: '',
                excludedPaths: '',
                lastSyncStatus: 'idle',
                lastSyncTimestamp: null
            },
            statusBarItemEl: statusBar,
            saveSettings: jest.fn().mockResolvedValue(undefined),
            errorLog
        });
    });

    test('does not start without credentials', async () => {
        plugin.settings.githubToken = '';

        await plugin.runSync();

        expect(syncEngineMock).not.toHaveBeenCalled();
        expect(Notice.messages).toContain('Ray Vault Sync: GitHub PAT not configured.');
    });

    test('runs sync, persists success, and reports progress', async () => {
        mockEngine.executeSync.mockImplementation(async (progress: (message: string) => void) => {
            progress('Uploading notes...');
        });
        const now = 1_725_534_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(now);

        await plugin.runSync();

        expect(syncEngineMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'main');
        expect(plugin.settings.lastSyncTimestamp).toBe(now);
        expect(plugin.settings.lastSyncStatus).toBe('success');
        expect(plugin.settings.lastSyncMessage).toBeUndefined();
        expect(statusBar.setText).toHaveBeenLastCalledWith('Ray Sync: Auto-sync off · Just now');
        expect(Notice.messages).toContain('Ray Vault Sync: Syncing with GitHub...');
        expect(Notice.messages.at(-1)).toContain('Ray Vault Sync: Synced successfully at ');
    });

    test('keeps the last successful timestamp and pauses auto-sync after an unsafe failure', async () => {
        const lastSuccess = Date.now() - 120_000;
        plugin.settings.autoSyncEnabled = true;
        plugin.settings.autoSyncInterval = 2;
        plugin.settings.lastSyncTimestamp = lastSuccess;
        plugin.settings.lastSyncStatus = 'success';
        const clearInterval = jest.fn();
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { setInterval: jest.fn(() => 42), clearInterval, setTimeout: jest.fn() }
        });
        plugin.setupAutoSync();
        mockEngine.executeSync.mockRejectedValueOnce(new SyncSafetyError('Invalid path: notes/bad:name.md'));

        await plugin.runSync(true);

        expect(plugin.settings.lastSyncTimestamp).toBe(lastSuccess);
        expect(plugin.settings.lastSyncStatus).toBe('error');
        expect(plugin.settings.autoSyncPausedReason).toContain('bad:name.md');
        expect(plugin.settings.autoSyncPausedReason).toContain('Auto-Sync paused');
        expect(plugin.settings.autoSyncInterval).toBe(2);
        expect(clearInterval).toHaveBeenCalledWith(42);
    });

    test('bounds automatic transient failures and resumes after a successful manual sync', async () => {
        plugin.settings.autoSyncEnabled = true;
        plugin.settings.autoSyncInterval = 2;
        const clearInterval = jest.fn();
        const setInterval = jest.fn(() => 42);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { setInterval, clearInterval, setTimeout: jest.fn() }
        });
        plugin.setupAutoSync();
        mockEngine.executeSync.mockRejectedValue(new Error('Network unavailable'));

        await plugin.runSync(true);
        expect(plugin.settings.autoSyncRetryAfter).toBeGreaterThan(Date.now());
        await plugin.runSync(true);
        expect(mockEngine.executeSync).toHaveBeenCalledTimes(1);
        plugin.settings.autoSyncRetryAfter = 0;
        await plugin.runSync(true);
        plugin.settings.autoSyncRetryAfter = 0;
        await plugin.runSync(true);

        expect(plugin.settings.autoSyncFailureCount).toBe(3);
        expect(plugin.settings.autoSyncPausedReason).toContain('consecutive automatic failures');
        expect(clearInterval).toHaveBeenCalledWith(42);
        await plugin.runSync(true);
        expect(mockEngine.executeSync).toHaveBeenCalledTimes(3);

        mockEngine.executeSync.mockResolvedValueOnce(undefined);
        await plugin.runSync(false);

        expect(plugin.settings.autoSyncPausedReason).toBeUndefined();
        expect(plugin.settings.autoSyncFailureCount).toBe(0);
        expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 120_000);
    });

    test('shows freshness, saved commit, and a sanitized latest error in Show Sync Status', async () => {
        const now = Date.now();
        plugin.settings.autoSyncEnabled = true;
        plugin.settings.autoSyncInterval = 10;
        plugin.settings.lastSyncTimestamp = now - 60_000;
        plugin.settings.lastSyncStatus = 'error';
        plugin.settings.lastSyncMessage = 'request failed with token';
        localVaultMock.mockImplementation((() => ({
            getSyncState: jest.fn().mockResolvedValue({ lastSyncedCommit: 'saved-commit-sha' })
        })) as never);
        const commands: Array<{ id: string; callback: () => void }> = [];
        Object.assign(plugin, {
            app: { workspace: { onLayoutReady: jest.fn(), on: jest.fn() } },
            loadData: jest.fn().mockResolvedValue({
                githubToken: 'token',
                repository: 'owner/repo',
                branch: 'main',
                autoSyncEnabled: true,
                autoSyncInterval: 10,
                lastSyncTimestamp: now - 60_000,
                lastSyncStatus: 'error',
                lastSyncMessage: 'request failed with token'
            }),
            addCommand: (command: { id: string; callback: () => void }) => commands.push(command)
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { setInterval: jest.fn(() => 42), clearInterval: jest.fn(), setTimeout: jest.fn() }
        });

        await plugin.onload();
        commands.find(command => command.id === 'show-status')?.callback();
        await new Promise(resolve => setImmediate(resolve));

        expect(Notice.messages.at(-1)).toContain('Auto-sync: Enabled (every 10 minutes)');
        expect(Notice.messages.at(-1)).toContain('State: Error');
        expect(Notice.messages.at(-1)).toContain('saved-commit-sha');
        expect(Notice.messages.at(-1)).toContain('[REDACTED]');
        expect(Notice.messages.at(-1)).not.toContain('request failed with token');
    });

    test('logs failures and enforces a rate-limit cooldown for manual runs', async () => {
        mockEngine.executeSync.mockRejectedValueOnce(new Error('GitHub API Rate Limit exceeded. Will reset in 20s.'));

        await plugin.runSync(true);

        expect(errorLog.log).toHaveBeenCalledWith('runSync', expect.any(Error));
        expect(plugin.settings.lastSyncStatus).toBe('error');
        expect(statusBar.setText).toHaveBeenLastCalledWith('Ray Sync: Error');
        expect(Notice.messages).toContain('Ray Vault Sync: Rate limit hit. Cooling down for 1m.');

        await plugin.runSync(false);
        expect(Notice.messages.at(-1)).toContain('cooldown active');
        expect(mockEngine.executeSync).toHaveBeenCalledTimes(1);
    });

    test('rejects overlapping manual sync and clears the in-progress flag afterward', async () => {
        let completeSync: (() => void) | undefined;
        mockEngine.executeSync.mockImplementation(() => new Promise<void>(resolve => {
            completeSync = resolve;
        }));

        const activeSync = plugin.runSync(true);
        await Promise.resolve();
        await plugin.runSync(false);
        expect(Notice.messages).toContain('Ray Vault Sync: Sync already in progress...');

        completeSync?.();
        await activeSync;
        expect(plugin.settings.lastSyncStatus).toBe('success');
    });

    test('replaces and disables automatic sync timers as settings change', () => {
        const setInterval = jest.fn(() => 42);
        const clearInterval = jest.fn();
        const setTimeout = jest.fn();
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { setInterval, clearInterval, setTimeout }
        });
        plugin.settings.autoSyncEnabled = true;
        plugin.settings.autoSyncInterval = 2;

        plugin.setupAutoSync();
        expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 120_000);
        expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);

        plugin.setupAutoSync();
        expect(clearInterval).toHaveBeenCalledWith(42);

        plugin.settings.autoSyncEnabled = false;
        plugin.setupAutoSync();
        expect(setInterval).toHaveBeenCalledTimes(2);
    });

    test('registers plugin commands and widget lifecycle during load', async () => {
        const commands: Array<{ id: string; callback: () => void }> = [];
        const ribbon = jest.fn();
        const settingTab = jest.fn();
        const registeredEvent = jest.fn();
        const layoutChange = jest.fn();
        const widgetMount = jest.fn();
        const widgetDestroy = jest.fn();
        jest.mocked(MobileSyncWidget).mockImplementationOnce((() => ({
            mount: widgetMount,
            destroy: widgetDestroy,
            setError: jest.fn(),
            setSyncing: jest.fn(),
            setSuccess: jest.fn(),
            updateState: jest.fn()
        })) as never);
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { clearInterval: jest.fn(), setInterval: jest.fn(() => 77), setTimeout: jest.fn() }
        });
        Object.assign(plugin, {
            app: {
                workspace: {
                    onLayoutReady: (callback: () => void) => callback(),
                    on: (_event: string, callback: () => void) => {
                        layoutChange.mockImplementation(callback);
                        return registeredEvent;
                    }
                }
            },
            manifest: { version: '1.3.0' },
            addCommand: (command: { id: string; callback: () => void }) => commands.push(command),
            addRibbonIcon: (_icon: string, _title: string, callback: () => void) => {
                ribbon.mockImplementation(callback);
                return { addClass: jest.fn() };
            },
            addSettingTab: settingTab,
            addStatusBarItem: () => ({ setText: jest.fn() }),
            registerEvent: registeredEvent,
            registerDomEvent: jest.fn(),
            registerInterval: jest.fn(),
            runSync: jest.fn()
        });

        await plugin.onload();

        expect(commands.map(command => command.id)).toEqual([
            'sync-now', 'show-status', 'resume-auto-sync', 'run-diagnostics'
        ]);
        expect(settingTab).toHaveBeenCalledTimes(1);
        expect(widgetMount).toHaveBeenCalledTimes(1);
        layoutChange();
        expect(widgetMount).toHaveBeenCalledTimes(2);

        commands[0].callback();
        ribbon();
        expect(plugin.runSync).toHaveBeenCalledTimes(2);
        commands[1].callback();
        await new Promise(resolve => setImmediate(resolve));
        expect(Notice.messages.at(-1)).toContain('Target: ufebri/raylabs-vault');
        commands[3].callback();

        plugin.settings.enableMobileSidebarWidget = false;
        plugin.refreshMobileWidget();
        expect(widgetDestroy).toHaveBeenCalled();
        plugin.settings.autoSyncEnabled = true;
        plugin.setupAutoSync();
        plugin.onunload();
        expect(widgetDestroy).toHaveBeenCalledTimes(2);
    });
});
