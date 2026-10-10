import { Notice } from 'obsidian';
import RayVaultSyncPlugin from '../src/main';
import { LocalVault } from '../src/local-vault';
import { GitHubClient } from '../src/github-client';
import { SyncEngine } from '../src/sync-core';
import { MobileSyncWidget } from '../src/mobile-widget';

jest.mock('../src/local-vault');
jest.mock('../src/github-client');
jest.mock('../src/sync-core');
jest.mock('../src/diagnostics', () => ({ runDiagnostics: jest.fn() }));
jest.mock('../src/mobile-widget', () => ({
    MobileSyncWidget: jest.fn().mockImplementation(() => ({
        mount: jest.fn(),
        destroy: jest.fn(),
        setError: jest.fn(),
        setSyncing: jest.fn(),
        setSuccess: jest.fn()
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
        localVaultMock.mockImplementation((() => ({})) as never);
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
        expect(statusBar.setText).toHaveBeenLastCalledWith(`Ray Sync: Synced at ${new Date(now).toLocaleTimeString()}`);
        expect(Notice.messages).toContain('Ray Vault Sync: Syncing with GitHub...');
        expect(Notice.messages.at(-1)).toContain('Ray Vault Sync: Synced successfully at ');
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
            setSuccess: jest.fn()
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

        expect(commands.map(command => command.id)).toEqual(['sync-now', 'show-status', 'run-diagnostics']);
        expect(settingTab).toHaveBeenCalledTimes(1);
        expect(widgetMount).toHaveBeenCalledTimes(1);
        layoutChange();
        expect(widgetMount).toHaveBeenCalledTimes(2);

        commands[0].callback();
        ribbon();
        expect(plugin.runSync).toHaveBeenCalledTimes(2);
        commands[1].callback();
        expect(Notice.messages.at(-1)).toContain('Target: ufebri/raylabs-vault');
        commands[2].callback();

        plugin.settings.enableMobileSidebarWidget = false;
        plugin.refreshMobileWidget();
        expect(widgetDestroy).toHaveBeenCalled();
        plugin.settings.autoSyncEnabled = true;
        plugin.setupAutoSync();
        plugin.onunload();
        expect(widgetDestroy).toHaveBeenCalledTimes(2);
    });
});
