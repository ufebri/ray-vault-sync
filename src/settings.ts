import { App, PluginSettingTab, Setting } from 'obsidian';
import RayVaultSyncPlugin from './main';

export interface RayVaultSyncSettings {
    githubToken: string;
    repository: string;
    branch: string;
    autoSyncEnabled: boolean;
    autoSyncInterval: number;
}

export const DEFAULT_SETTINGS: RayVaultSyncSettings = {
    githubToken: '',
    repository: 'ufebri/raylabs-vault',
    branch: 'main',
    autoSyncEnabled: false,
    autoSyncInterval: 5
};

export class RayVaultSyncSettingTab extends PluginSettingTab {
    plugin: RayVaultSyncPlugin;

    constructor(app: App, plugin: RayVaultSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): any[] {
        return [];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Ray Vault Sync Settings')
            .setDesc('Easy, free, cross-device GitHub synchronization for your Obsidian vault.')
            .setHeading();

        new Setting(containerEl)
            .setName('GitHub Personal Access Token')
            .setDesc('Fine-grained PAT with Contents: Read and write permissions.')
            .addText(text => text
                .setPlaceholder('github_pat_...')
                .setValue(this.plugin.settings.githubToken)
                .onChange(async (value) => {
                    this.plugin.settings.githubToken = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('GitHub Repository')
            .setDesc('Format: owner/repo (e.g. ufebri/raylabs-vault)')
            .addText(text => text
                .setPlaceholder('owner/repo')
                .setValue(this.plugin.settings.repository)
                .onChange(async (value) => {
                    this.plugin.settings.repository = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Branch')
            .setDesc('Target branch to synchronize with (default: main)')
            .addText(text => text
                .setPlaceholder('main')
                .setValue(this.plugin.settings.branch)
                .onChange(async (value) => {
                    this.plugin.settings.branch = value.trim() || 'main';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable Auto-Sync')
            .setDesc('Automatically synchronize changes in the background while Obsidian is open')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSyncEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.autoSyncEnabled = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName('Auto-Sync Interval (minutes)')
            .setDesc('How often to synchronize automatically (minimum: 1 minute)')
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
    }
}
