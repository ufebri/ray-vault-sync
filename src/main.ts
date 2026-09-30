import { Plugin, Notice, Platform } from 'obsidian';
import { RayVaultSyncSettings, DEFAULT_SETTINGS, RayVaultSyncSettingTab } from './settings';
import { SyncEngine } from './sync-core';
import { LocalVault } from './local-vault';
import { GitHubClient } from './github-client';
import { runDiagnostics } from './diagnostics';
import { MobileSyncWidget } from './mobile-widget';
import { ErrorLogManager } from './error-log';

export default class RayVaultSyncPlugin extends Plugin {
    settings!: RayVaultSyncSettings;
    statusBarItemEl!: HTMLElement;

    private autoSyncIntervalId: number | null = null;
    private isSyncing = false;
    private rateLimitResetTime = 0;
    private mobileWidget: MobileSyncWidget | null = null;
    private errorLog!: ErrorLogManager;

    async onload() {
        await this.loadSettings();

        this.errorLog = new ErrorLogManager(
            this.app,
            () => [this.settings.githubToken],
            this.manifest?.version ?? 'dev',
            Platform.isMobile ? 'mobile' : 'desktop'
        );

        this.registerDomEvent(window, 'error', (e: ErrorEvent) => {
            void this.errorLog.log('window.onerror', e.error ?? e.message);
        });
        this.registerDomEvent(window, 'unhandledrejection', (e: PromiseRejectionEvent) => {
            void this.errorLog.log('unhandledrejection', e.reason);
        });

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

        // Initialize Mobile Sidebar Widget
        this.mobileWidget = new MobileSyncWidget(this);
        this.app.workspace.onLayoutReady(() => {
            try {
                this.mobileWidget?.mount();
            } catch (error: unknown) {
                void this.errorLog.log('widget.mount', error);
            }
        });
        this.registerEvent(this.app.workspace.on('layout-change', () => {
            this.mobileWidget?.mount();
        }));
    }

    onunload() {
        if (this.autoSyncIntervalId !== null) {
            window.clearInterval(this.autoSyncIntervalId);
        }
        if (this.mobileWidget) {
            this.mobileWidget.destroy();
            this.mobileWidget = null;
        }
    }

    refreshMobileWidget() {
        if (this.settings.enableMobileSidebarWidget) {
            this.mobileWidget?.mount();
        } else {
            this.mobileWidget?.destroy();
        }
    }

    getErrorLog(): ErrorLogManager {
        return this.errorLog;
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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<RayVaultSyncSettings>);
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
        this.settings.lastSyncStatus = 'syncing';
        this.mobileWidget?.setSyncing();

        try {
            if (!isAuto) new Notice('Ray Vault Sync: Syncing with GitHub...');
            this.statusBarItemEl.setText('Ray Sync: Syncing...');

            const localVault = new LocalVault(this.app, this.settings.excludedPaths);
            const githubClient = new GitHubClient(this.settings.githubToken, this.settings.repository);
            const engine = new SyncEngine(localVault, githubClient, this.settings.branch || 'main');

            await engine.executeSync((progressMsg) => {
                this.statusBarItemEl.setText(`Ray Sync: ${progressMsg}`);
            });

            const now = Date.now();
            this.settings.lastSyncTimestamp = now;
            this.settings.lastSyncStatus = 'success';
            this.settings.lastSyncMessage = undefined;
            await this.saveSettings();

            this.mobileWidget?.setSuccess(now);

            const dateStr = new Date(now).toLocaleTimeString();
            if (!isAuto) new Notice(`Ray Vault Sync: Synced successfully at ${dateStr}`);
            this.statusBarItemEl.setText(`Ray Sync: Synced at ${dateStr}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            void this.errorLog.log('runSync', error);
            
            this.settings.lastSyncStatus = 'error';
            this.settings.lastSyncMessage = msg;
            await this.saveSettings();

            this.mobileWidget?.setError(msg);

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
