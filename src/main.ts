import { Plugin, Notice, Platform } from 'obsidian';
import { RayVaultSyncSettings, DEFAULT_SETTINGS, RayVaultSyncSettingTab } from './settings';
import { SyncEngine, SyncSafetyError } from './sync-core';
import { LocalVault } from './local-vault';
import { GitHubClient } from './github-client';
import { runDiagnostics } from './diagnostics';
import { getSyncFreshness, formatRelativeTime, MobileSyncWidget } from './mobile-widget';
import { ErrorLogManager, redactText } from './error-log';

export default class RayVaultSyncPlugin extends Plugin {
    settings!: RayVaultSyncSettings;
    statusBarItemEl!: HTMLElement;

    private autoSyncIntervalId: number | null = null;
    private statusRefreshIntervalId: number | null = null;
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
        this.statusRefreshIntervalId = window.setInterval(() => this.refreshStatusSurfaces(), 30_000);
        this.registerInterval(this.statusRefreshIntervalId);
        this.refreshStatusSurfaces();

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
                void this.showSyncStatus();
            }
        });

        this.addCommand({
            id: 'resume-auto-sync',
            name: 'Resume Auto-Sync',
            callback: () => {
                void this.resumeAutoSync();
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
        if (this.statusRefreshIntervalId !== null) {
            window.clearInterval(this.statusRefreshIntervalId);
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

    setupAutoSync(runImmediately = true) {
        this.clearAutoSyncTimer();

        if (this.settings.autoSyncEnabled && this.settings.autoSyncInterval > 0 && !this.settings.autoSyncPausedReason) {
            const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
            this.autoSyncIntervalId = window.setInterval(() => {
                void this.runSync(true);
            }, intervalMs);

            this.registerInterval(this.autoSyncIntervalId);

            if (runImmediately && (!this.settings.autoSyncRetryAfter || Date.now() >= this.settings.autoSyncRetryAfter)) {
                window.setTimeout(() => {
                    void this.runSync(true);
                }, 5000);
            }
        }
        this.refreshStatusSurfaces();
    }

    async loadSettings() {
        this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<RayVaultSyncSettings>) };
        if (this.settings.lastSyncMessage) {
            this.settings.lastSyncMessage = redactText(this.settings.lastSyncMessage, [this.settings.githubToken]);
        }
        if (this.settings.autoSyncPausedReason) {
            this.settings.autoSyncPausedReason = redactText(this.settings.autoSyncPausedReason, [this.settings.githubToken]);
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private canStartSync(isAuto: boolean): boolean {
        if (this.isSyncing) {
            if (!isAuto) new Notice('Ray Vault Sync: Sync already in progress...');
            return false;
        }
        if (Date.now() < this.rateLimitResetTime) {
            if (!isAuto) {
                const waitMins = Math.ceil((this.rateLimitResetTime - Date.now()) / 60000);
                new Notice(`Ray Vault Sync: GitHub rate limit cooldown active. Try again in ${waitMins}m.`);
            }
            return false;
        }
        if (isAuto && (this.settings.autoSyncPausedReason ||
            (this.settings.autoSyncRetryAfter !== undefined && Date.now() < this.settings.autoSyncRetryAfter))) {
            return false;
        }
        if (!this.settings.githubToken) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub PAT not configured.');
            return false;
        }
        if (!this.settings.repository) {
            if (!isAuto) new Notice('Ray Vault Sync: GitHub repository not configured.');
            return false;
        }
        return true;
    }

    private clearAutoSyncTimer(): void {
        if (this.autoSyncIntervalId !== null) {
            window.clearInterval(this.autoSyncIntervalId);
            this.autoSyncIntervalId = null;
        }
    }

    private refreshStatusSurfaces(): void {
        if (this.statusBarItemEl) {
            const labels = {
                off: 'Auto-sync off',
                syncing: 'Syncing...',
                fresh: 'Up to date',
                stale: 'Sync overdue',
                error: 'Error'
            };
            const freshness = getSyncFreshness(this.settings);
            const lastSync = this.settings.lastSyncTimestamp
                ? ` · ${formatRelativeTime(this.settings.lastSyncTimestamp)}`
                : '';
            this.statusBarItemEl.setText(`Ray Sync: ${labels[freshness]}${lastSync}`);
        }
        this.mobileWidget?.updateState();
    }

    private async showSyncStatus(): Promise<void> {
        let savedCommit = 'Unavailable';
        try {
            const state = await new LocalVault(this.app, this.settings.excludedPaths).getSyncState();
            savedCommit = state?.lastSyncedCommit || 'None';
        } catch {
            savedCommit = 'Could not read local sync state';
        }
        const freshnessLabels = {
            off: 'Auto-sync off',
            syncing: 'Syncing',
            fresh: 'Fresh',
            stale: 'Stale — last successful sync is outside the freshness window',
            error: 'Error'
        };
        const timestamp = this.settings.lastSyncTimestamp;
        const lastSuccess = timestamp
            ? `${formatRelativeTime(timestamp)} (${new Date(timestamp).toLocaleString()})`
            : 'Never';
        const lines = [
            `Target: ${this.settings.repository || 'No repository set'} / ${this.settings.branch || 'main'}`,
            `Auto-sync: ${this.settings.autoSyncEnabled ? `Enabled (every ${this.settings.autoSyncInterval} minutes)` : 'Off — remote changes will not arrive automatically'}`,
            `State: ${freshnessLabels[getSyncFreshness(this.settings)]}`,
            `Last successful sync: ${lastSuccess}`,
            `Saved commit: ${savedCommit}`
        ];
        if (this.settings.lastSyncMessage) lines.push(`Latest error: ${redactText(this.settings.lastSyncMessage, [this.settings.githubToken])}`);
        if (this.settings.autoSyncPausedReason) lines.push(this.settings.autoSyncPausedReason);
        new Notice(`Ray Vault Sync\n${lines.join('\n')}`, 10_000);
    }

    private async resumeAutoSync(): Promise<void> {
        if (!this.settings.autoSyncEnabled) {
            new Notice('Ray Vault Sync: Enable Auto-Sync in settings before resuming it.');
            return;
        }
        this.settings.autoSyncPausedReason = undefined;
        this.settings.autoSyncFailureCount = 0;
        this.settings.autoSyncRetryAfter = undefined;
        await this.saveSettings();
        this.setupAutoSync();
        new Notice('Ray Vault Sync: Auto-Sync resumed.');
    }

    private async handleSyncError(error: unknown, isAuto: boolean): Promise<void> {
        const msg = error instanceof Error ? error.message : String(error);
        const safeMsg = redactText(msg, [this.settings.githubToken]);
        void this.errorLog.log('runSync', error);
        this.settings.lastSyncStatus = 'error';
        this.settings.lastSyncMessage = safeMsg;

        if (error instanceof SyncSafetyError) {
            this.settings.autoSyncPausedReason = `Auto-Sync paused after a safety stop: ${safeMsg}`;
            this.settings.autoSyncRetryAfter = undefined;
            this.clearAutoSyncTimer();
        } else if (isAuto) {
            const failures = (this.settings.autoSyncFailureCount ?? 0) + 1;
            this.settings.autoSyncFailureCount = failures;
            if (failures >= 3) {
                this.settings.autoSyncPausedReason = `Auto-Sync paused after ${failures} consecutive automatic failures: ${safeMsg}`;
                this.settings.autoSyncRetryAfter = undefined;
                this.clearAutoSyncTimer();
            } else {
                const delay = failures === 1 ? 60_000 : 5 * 60_000;
                this.settings.autoSyncRetryAfter = Date.now() + delay;
            }
        }
        await this.saveSettings();
        this.refreshStatusSurfaces();

        if (msg.includes('Rate Limit') || msg.includes('abuse limit')) {
            const match = /reset in (\d+)s/.exec(msg);
            const waitMs = match ? Number.parseInt(match[1], 10) * 1000 : 60 * 60 * 1000;
            this.rateLimitResetTime = Date.now() + waitMs;
            new Notice(`Ray Vault Sync: Rate limit hit. Cooling down for ${Math.ceil(waitMs/60000)}m.`);
        } else if (!isAuto) {
            const pauseNotice = error instanceof SyncSafetyError
                ? `\n${this.settings.autoSyncPausedReason}`
                : '';
            new Notice(`Ray Vault Sync failed: ${safeMsg}${pauseNotice}`);
        }
        this.statusBarItemEl.setText('Ray Sync: Error');
    }

    async runSync(isAuto: boolean = false) {
        if (!this.canStartSync(isAuto)) return;

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
            const wasPaused = Boolean(this.settings.autoSyncPausedReason);
            this.settings.lastSyncTimestamp = now;
            this.settings.lastSyncStatus = 'success';
            this.settings.lastSyncMessage = undefined;
            this.settings.autoSyncFailureCount = 0;
            this.settings.autoSyncRetryAfter = undefined;
            this.settings.autoSyncPausedReason = undefined;
            await this.saveSettings();

            if (!isAuto && wasPaused && this.settings.autoSyncEnabled) this.setupAutoSync(false);
            this.refreshStatusSurfaces();

            const dateStr = new Date(now).toLocaleTimeString();
            if (!isAuto) new Notice(`Ray Vault Sync: Synced successfully at ${dateStr}`);
        } catch (error: unknown) {
            await this.handleSyncError(error, isAuto);
        } finally {
            this.isSyncing = false;
            this.refreshStatusSurfaces();
        }
    }
}
