import { Plugin, Notice } from 'obsidian';
import { RayVaultSyncSettings, DEFAULT_SETTINGS, RayVaultSyncSettingTab } from './settings';
import { SyncEngine } from './sync-core';
import { LocalVault } from './local-vault';
import { GitHubClient } from './github-client';
import { runDiagnostics } from './diagnostics';

export default class RayVaultSyncPlugin extends Plugin {
    settings!: RayVaultSyncSettings;
    statusBarItemEl!: HTMLElement;

    private autoSyncIntervalId: number | null = null;

    async onload() {
        await this.loadSettings();

        this.setupAutoSync();

        this.addSettingTab(new RayVaultSyncSettingTab(this.app, this));

        // Add status bar item (Desktop)
        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.setText('Ray Sync: Idle');

        // Add left ribbon icon
        const ribbonIconEl = this.addRibbonIcon('sync', 'Ray Vault Sync', () => {
            this.runSync(false);
        });
        ribbonIconEl.addClass('ray-vault-sync-ribbon-class');

        // Command: Sync Now
        this.addCommand({
            id: 'sync-now',
            name: 'Sync Now',
            callback: () => {
                this.runSync(false);
            }
        });
        
        // Command: Show Status
        this.addCommand({
            id: 'show-status',
            name: 'Show Sync Status',
            callback: () => {
                new Notice(`Ray Vault Sync is Idle. Target: ${this.settings.repository || 'No repo set'}`);
            }
        });

        // Command: Run Diagnostics
        this.addCommand({
            id: 'run-diagnostics',
            name: 'Run Diagnostics',
            callback: () => {
                runDiagnostics(this.app, this.settings);
            }
        });
    }

    onunload() {
        if (this.autoSyncIntervalId !== null) {
            window.clearInterval(this.autoSyncIntervalId);
        }
    }

    setupAutoSync() {
        if (this.autoSyncIntervalId !== null) {
            window.clearInterval(this.autoSyncIntervalId);
            this.autoSyncIntervalId = null;
        }

        if (this.settings.autoSyncEnabled && this.settings.autoSyncInterval > 0) {
            const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
            this.autoSyncIntervalId = window.setInterval(() => {
                this.runSync(true);
            }, intervalMs);

            this.registerInterval(this.autoSyncIntervalId);
            
            // Initial sync after 5 seconds
            setTimeout(() => {
                this.runSync(true);
            }, 5000);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async runSync(isAuto: boolean = false) {
        if (!this.settings.githubToken) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub Personal Access Token is not configured. Please check settings.');
            return;
        }

        if (!this.settings.repository) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub repository is not configured.');
            return;
        }

        try {
            if (!isAuto) new Notice('Ray Vault Sync: Syncing with GitHub...');
            this.statusBarItemEl.setText('Ray Sync: Syncing...');

            const localVault = new LocalVault(this.app);
            const githubClient = new GitHubClient(this.settings.githubToken, this.settings.repository);
            const engine = new SyncEngine(localVault, githubClient, this.settings.branch || 'main');

            await engine.executeSync();

            const dateStr = new Date().toLocaleTimeString();
            if (!isAuto) new Notice(`Ray Vault Sync: Synced successfully at ${dateStr}`);
            this.statusBarItemEl.setText(`Ray Sync: Synced at ${dateStr}`);
        } catch (error: any) {
            console.error('Ray Vault Sync error:', error);
            if (!isAuto) new Notice(`Ray Vault Sync failed: ${error.message}`);
            this.statusBarItemEl.setText('Ray Sync: Error');
        }
    }
}
