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
    private isSyncing = false;
    private rateLimitResetTime = 0;

    async onload() {
        await this.loadSettings();

        this.setupAutoSync();

        this.addSettingTab(new RayVaultSyncSettingTab(this.app, this));

        // Add status bar item (Desktop)
        this.statusBarItemEl = this.addStatusBarItem();
        this.statusBarItemEl.setText('Ray Sync: Idle');

        // Add left ribbon icon
        const ribbonIconEl = this.addRibbonIcon('sync', 'Ray Vault Sync', () => {
            void this.runSync(false);
        });
        ribbonIconEl.addClass('ray-vault-sync-ribbon-class');

        // Command: Sync Now
        this.addCommand({
            id: 'sync-now',
            name: 'Sync Now',
            callback: () => {
                void this.runSync(false);
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
                void runDiagnostics(this.app, this.settings);
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
                void this.runSync(true);
            }, intervalMs);

            this.registerInterval(this.autoSyncIntervalId);
            
            // Initial sync after 5 seconds
            window.setTimeout(() => {
                void this.runSync(true);
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
        if (this.isSyncing) {
            if (!isAuto) new Notice('Ray Vault Sync: Sync already in progress...');
            return;
        }

        if (Date.now() < this.rateLimitResetTime) {
            if (!isAuto) {
                const waitMins = Math.ceil((this.rateLimitResetTime - Date.now()) / 60000);
                new Notice(`Ray Vault Sync: GitHub rate limit cooldown active. Try again in ${waitMins}m.`);
            }
            return;
        }

        if (!this.settings.githubToken) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub PAT not configured.');
            return;
        }

        if (!this.settings.repository) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub repository not configured.');
            return;
        }

        this.isSyncing = true;
        try {
            if (!isAuto) new Notice('Ray Vault Sync: Syncing with GitHub...');
            this.statusBarItemEl.setText('Ray Sync: Syncing...');

            const localVault = new LocalVault(this.app);
            const githubClient = new GitHubClient(this.settings.githubToken, this.settings.repository);
            const engine = new SyncEngine(localVault, githubClient, this.settings.branch || 'main');

            await engine.executeSync((progressMsg) => {
                this.statusBarItemEl.setText(`Ray Sync: ${progressMsg}`);
            });

            const dateStr = new Date().toLocaleTimeString();
            if (!isAuto) new Notice(`Ray Vault Sync: Synced successfully at ${dateStr}`);
            this.statusBarItemEl.setText(`Ray Sync: Synced at ${dateStr}`);
        } catch (error: unknown) {
            console.error('Ray Vault Sync error:', error);
            const msg = error instanceof Error ? error.message : String(error);
            
            if (msg.includes('Rate Limit') || msg.includes('abuse limit')) {
                // If it's a rate limit error without a specific reset time returned, default to 1 hour
                const match = msg.match(/reset in (\d+)s/);
                const waitMs = match ? parseInt(match[1]) * 1000 : 60 * 60 * 1000;
                this.rateLimitResetTime = Date.now() + waitMs;
                new Notice(`Ray Vault Sync: Rate limit hit. Cooling down for ${Math.ceil(waitMs/60000)}m.`);
            } else if (!isAuto) {
                new Notice(`Ray Vault Sync failed: ${msg}`);
            }
            
            this.statusBarItemEl.setText('Ray Sync: Error');
        } finally {
            this.isSyncing = false;
        }
    }
}
