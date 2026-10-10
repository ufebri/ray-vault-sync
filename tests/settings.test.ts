import { Notice, Setting } from 'obsidian';
import { RayVaultSyncSettingTab } from '../src/settings';

describe('RayVaultSyncSettingTab', () => {
    const makePlugin = () => ({
        settings: {
            githubToken: 'token',
            repository: 'owner/repo',
            branch: 'main',
            autoSyncEnabled: false,
            autoSyncInterval: 5,
            excludedPaths: '',
            enableMobileSidebarWidget: true
        },
        saveSettings: jest.fn().mockResolvedValue(undefined),
        setupAutoSync: jest.fn(),
        refreshMobileWidget: jest.fn(),
        getErrorLog: jest.fn().mockReturnValue({
            formatRecent: jest.fn().mockResolvedValue('safe report'),
            clear: jest.fn().mockResolvedValue(undefined)
        })
    });

    beforeEach(() => {
        Setting.instances.length = 0;
        Notice.messages.length = 0;
    });

    test('renders settings and persists normalized changes', async () => {
        const plugin = makePlugin();
        const tab = new RayVaultSyncSettingTab({} as never, plugin as never);

        tab.display();

        expect(tab.containerEl.empty).toHaveBeenCalled();
        expect(Setting.instances.map(setting => setting.name)).toEqual([
            'GitHub Personal Access Token',
            'GitHub Repository',
            'Branch',
            'Sync automatically',
            'How often to sync',
            'Folders to skip',
            'Sync button in the file list',
            'Trouble history'
        ]);

        const [token, repository, branch, autoSync, interval, excluded, widget] =
            Setting.instances.slice(0, 7).map(setting => setting.controls[0]);
        await token.onChangeHandler?.('  secret  ');
        await repository.onChangeHandler?.(' owner/new-repo ');
        await branch.onChangeHandler?.('');
        await autoSync.onChangeHandler?.(true);
        await interval.onChangeHandler?.('0');
        await interval.onChangeHandler?.('not a number');
        await excluded.onChangeHandler?.('private, drafts');
        await widget.onChangeHandler?.(false);

        expect(plugin.settings).toMatchObject({
            githubToken: 'secret',
            repository: 'owner/new-repo',
            branch: 'main',
            autoSyncEnabled: true,
            autoSyncInterval: 1,
            excludedPaths: 'private, drafts',
            enableMobileSidebarWidget: false
        });
        expect(plugin.saveSettings).toHaveBeenCalledTimes(7);
        expect(plugin.setupAutoSync).toHaveBeenCalledTimes(2);
        expect(plugin.refreshMobileWidget).toHaveBeenCalledTimes(1);
        expect(tab.getSettingDefinitions()).toEqual([]);
    });

    test('runs report, copy, and clear actions and reports clipboard failures', async () => {
        const plugin = makePlugin();
        const open = jest.fn();
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { open } });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: { clipboard: { writeText } }
        });
        const tab = new RayVaultSyncSettingTab({} as never, plugin as never);
        tab.display();

        const buttons = Setting.instances[7].controls;
        buttons[0].onClickHandler();
        buttons[1].onClickHandler();
        buttons[2].onClickHandler();
        await new Promise(resolve => setImmediate(resolve));

        expect(open).toHaveBeenCalledWith(expect.stringContaining('issues/new?title='));
        expect(writeText).toHaveBeenCalledWith('safe report');
        expect(plugin.getErrorLog().clear).toHaveBeenCalled();
        expect(Notice.messages).toContain('Copied — paste it wherever you ask for help.');
        expect(Notice.messages).toContain('Trouble history cleared.');

        writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
        buttons[1].onClickHandler();
        await new Promise(resolve => setImmediate(resolve));
        expect(Notice.messages).toContain('Copy failed: clipboard unavailable');
    });
});
