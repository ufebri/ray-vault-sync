import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import RayVaultSyncPlugin from './main';

export interface RayVaultSyncSettings {
    githubToken: string;
    repository: string;
    branch: string;
    autoSyncEnabled: boolean;
    autoSyncInterval: number;
    excludedPaths: string;
    enableMobileSidebarWidget: boolean;
    lastSyncTimestamp: number | null;
    lastSyncStatus: 'idle' | 'syncing' | 'success' | 'error';
    lastSyncMessage?: string;
}

export const DEFAULT_SETTINGS: RayVaultSyncSettings = {
    githubToken: '',
    repository: 'ufebri/raylabs-vault',
    branch: 'main',
    autoSyncEnabled: false,
    autoSyncInterval: 5,
    excludedPaths: 'node_modules, .git, ray-vault-sync',
    enableMobileSidebarWidget: true,
    lastSyncTimestamp: null,
    lastSyncStatus: 'idle'
};

export class RayVaultSyncSettingTab extends PluginSettingTab {
    plugin: RayVaultSyncPlugin;

    constructor(app: App, plugin: RayVaultSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): never[] {
        return [];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('GitHub Personal Access Token')
            .setDesc('Secret key from GitHub that lets the plugin save your notes. You make it once on the GitHub website — it stays on your device.')
            .addText(text => text
                .setPlaceholder('github_pat_...')
                .setValue(this.plugin.settings.githubToken)
                .onChange(async (value) => {
                    this.plugin.settings.githubToken = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('GitHub Repository')
            .setDesc('Where your notes are stored on GitHub. Written as owner/name, for example ufebri/raylabs-vault.')
            .addText(text => text
                .setPlaceholder('owner/repo')
                .setValue(this.plugin.settings.repository)
                .onChange(async (value) => {
                    this.plugin.settings.repository = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Branch')
            .setDesc('Which version line to follow. Keep it as main unless you know you need something else.')
            .addText(text => text
                .setPlaceholder('main')
                .setValue(this.plugin.settings.branch)
                .onChange(async (value) => {
                    this.plugin.settings.branch = value.trim() || 'main';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync automatically')
            .setDesc('When on, your notes sync by themselves in the background while Obsidian is open.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSyncEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.autoSyncEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName('How often to sync')
            .setDesc('Waiting time between automatic syncs, in minutes. Shortest is 1 minute.')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.autoSyncInterval))
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.autoSyncInterval = Math.max(1, parsed);
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoSync();
                    }
                }));

        new Setting(containerEl)
            .setName('Folders to skip')
            .setDesc('Notes in these folders stay only on this device and are never uploaded. Separate with commas, for example: templates, private, archive.')
            .addTextArea(text => text
                .setPlaceholder('node_modules, .git, ray-vault-sync')
                .setValue(this.plugin.settings.excludedPaths || 'node_modules, .git, ray-vault-sync')
                .onChange(async (value) => {
                    this.plugin.settings.excludedPaths = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync button in the file list')
            .setDesc('Shows a handy Sync button with your last sync time at the top of the file list. Great on phones.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMobileSidebarWidget)
                .onChange(async (value) => {
                    this.plugin.settings.enableMobileSidebarWidget = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshMobileWidget();
                }));

        new Setting(containerEl)
            .setName('Trouble history')
            .setDesc('If sync ever fails, what happened is saved here on this device only — secret keys are hidden. Tap Report to open a pre-filled issue, or Copy to paste it anywhere.')
            .addButton(btn => btn
                .setButtonText('Report')
                .onClick(() => {
                    void (async () => {
                        const log = await this.plugin.getErrorLog().formatRecent(10);
                        const title = encodeURIComponent('[Error report] Ray Vault Sync');
                        const body = encodeURIComponent(
                            `**Describe what happened**\n\n\n**Trouble history (auto-attached, secrets hidden)**\n\`\`\`\n${log.slice(0, 6000)}\n\`\`\``
                        );
                        window.open(`https://github.com/ufebri/ray-vault-sync/issues/new?title=${title}&body=${body}`);
                    })();
                }))
            .addButton(btn => btn
                .setButtonText('Copy')
                .onClick(() => {
                    void (async () => {
                        try {
                            const text = await this.plugin.getErrorLog().formatRecent(20);
                            await navigator.clipboard.writeText(text);
                            new Notice('Copied — paste it wherever you ask for help.');
                        } catch (e: unknown) {
                            const msg = e instanceof Error ? e.message : String(e);
                            new Notice(`Copy failed: ${msg}`);
                        }
                    })();
                }))
            .addButton(btn => btn
                .setButtonText('Clear')
                .onClick(() => {
                    void (async () => {
                        await this.plugin.getErrorLog().clear();
                        new Notice('Trouble history cleared.');
                    })();
                }));
    }
}
