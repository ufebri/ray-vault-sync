import { setIcon } from 'obsidian';
import type RayVaultSyncPlugin from './main';

export class MobileSyncWidget {
    private plugin: RayVaultSyncPlugin;
    private containerEl: HTMLElement | null = null;
    private buttonEl: HTMLButtonElement | null = null;
    private iconEl: HTMLElement | null = null;
    private btnLabelEl: HTMLElement | null = null;
    private statusDotEl: HTMLElement | null = null;
    private statusTextEl: HTMLElement | null = null;
    private timeTextEl: HTMLElement | null = null;
    private timerId: number | null = null;

    constructor(plugin: RayVaultSyncPlugin) {
        this.plugin = plugin;
    }

    public mount(): void {
        if (!this.plugin.settings.enableMobileSidebarWidget) {
            this.destroy();
            return;
        }

        const leaves = this.plugin.app.workspace.getLeavesOfType('file-explorer');
        if (leaves.length === 0) return;

        const fileExplorerLeaf = leaves[0];
        const viewEl = fileExplorerLeaf.view.containerEl;

        // Check if already mounted
        const existingCard = viewEl.querySelector<HTMLElement>('#ray-vault-sync-mobile-card');
        if (existingCard) {
            this.containerEl = existingCard;
            this.updateState();
            return;
        }

        this.buildUI(viewEl);
        this.updateState();
        this.startRelativeTimeTimer();
    }

    private buildUI(viewEl: HTMLElement): void {
        this.containerEl = createDiv({
            cls: 'ray-vault-sync-mobile-card',
            attr: { id: 'ray-vault-sync-mobile-card' }
        });

        // Sync Action Button
        this.buttonEl = this.containerEl.createEl('button', {
            cls: 'ray-vault-sync-btn-sync mod-cta',
            attr: { 'aria-label': 'Sync Now with GitHub' }
        });

        this.iconEl = this.buttonEl.createSpan({ cls: 'ray-vault-sync-btn-icon' });
        setIcon(this.iconEl, 'sync');

        this.btnLabelEl = this.buttonEl.createSpan({
            cls: 'ray-vault-sync-btn-label',
            text: 'Sync Now'
        });

        this.buttonEl.addEventListener('click', () => {
            void this.plugin.runSync(false);
        });

        // Info container
        const infoBox = this.containerEl.createDiv({ cls: 'ray-vault-sync-info-box' });

        const statusRow = infoBox.createDiv({ cls: 'ray-vault-sync-status-row' });
        this.statusDotEl = statusRow.createSpan({ cls: 'ray-vault-sync-status-dot idle' });
        this.statusTextEl = statusRow.createSpan({ cls: 'ray-vault-sync-status-text', text: 'Idle' });

        this.timeTextEl = infoBox.createDiv({
            cls: 'ray-vault-sync-time-text',
            text: formatRelativeTime(this.plugin.settings.lastSyncTimestamp)
        });

        // Insert before .nav-files-container or at the beginning of the view
        const navFiles = viewEl.querySelector('.nav-files-container');
        if (navFiles && navFiles.parentElement) {
            navFiles.parentElement.insertBefore(this.containerEl, navFiles);
        } else {
            viewEl.prepend(this.containerEl);
        }
    }

    public setSyncing(): void {
        if (!this.containerEl) return;
        if (this.buttonEl) this.buttonEl.disabled = true;
        if (this.iconEl) this.iconEl.addClass('is-syncing');
        if (this.btnLabelEl) this.btnLabelEl.setText('Syncing...');
        if (this.statusDotEl) {
            this.statusDotEl.className = 'ray-vault-sync-status-dot syncing';
        }
        if (this.statusTextEl) this.statusTextEl.setText('Syncing...');
    }

    public setSuccess(timestamp: number): void {
        if (!this.containerEl) return;
        if (this.buttonEl) this.buttonEl.disabled = false;
        if (this.iconEl) this.iconEl.removeClass('is-syncing');
        if (this.btnLabelEl) this.btnLabelEl.setText('Sync Now');
        if (this.statusDotEl) {
            this.statusDotEl.className = 'ray-vault-sync-status-dot success';
        }
        if (this.statusTextEl) this.statusTextEl.setText('Synced');
        this.updateTimeDisplay(timestamp);
    }

    public setError(errorMsg?: string): void {
        if (!this.containerEl) return;
        if (this.buttonEl) this.buttonEl.disabled = false;
        if (this.iconEl) this.iconEl.removeClass('is-syncing');
        if (this.btnLabelEl) this.btnLabelEl.setText('Retry Sync');
        if (this.statusDotEl) {
            this.statusDotEl.className = 'ray-vault-sync-status-dot error';
        }
        if (this.statusTextEl) {
            const shortError = errorMsg && errorMsg.toLowerCase().includes('rate limit') ? 'Rate limit' : 'Sync Error';
            this.statusTextEl.setText(shortError);
            if (errorMsg) this.statusTextEl.setAttribute('title', errorMsg);
        }
    }

    public updateState(): void {
        if (!this.containerEl) return;
        const status = this.plugin.settings.lastSyncStatus || 'idle';
        if (status === 'syncing') {
            this.setSyncing();
        } else if (status === 'success') {
            this.setSuccess(this.plugin.settings.lastSyncTimestamp || Date.now());
        } else if (status === 'error') {
            this.setError(this.plugin.settings.lastSyncMessage);
        } else {
            if (this.buttonEl) this.buttonEl.disabled = false;
            if (this.iconEl) this.iconEl.removeClass('is-syncing');
            if (this.btnLabelEl) this.btnLabelEl.setText('Sync Now');
            if (this.statusDotEl) this.statusDotEl.className = 'ray-vault-sync-status-dot idle';
            if (this.statusTextEl) this.statusTextEl.setText('Idle');
            this.updateTimeDisplay(this.plugin.settings.lastSyncTimestamp);
        }
    }

    private updateTimeDisplay(timestamp: number | null = this.plugin.settings.lastSyncTimestamp): void {
        if (!this.timeTextEl) return;
        this.timeTextEl.setText(formatRelativeTime(timestamp));
        if (timestamp) {
            this.timeTextEl.setAttribute('title', `Last sync: ${new Date(timestamp).toLocaleTimeString()}`);
        } else {
            this.timeTextEl.removeAttribute('title');
        }
    }

    private startRelativeTimeTimer(): void {
        if (this.timerId !== null) return;
        this.timerId = window.setInterval(() => {
            this.updateTimeDisplay();
        }, 30_000);
    }

    public destroy(): void {
        if (this.timerId !== null) {
            window.clearInterval(this.timerId);
            this.timerId = null;
        }
        if (this.containerEl) {
            this.containerEl.remove();
            this.containerEl = null;
        }
    }
}

export function formatRelativeTime(timestamp: number | null, now: number = Date.now()): string {
    if (!timestamp) return 'Never synced';
    const diff = Math.max(0, now - timestamp);

    if (diff < 30_000) return 'Just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
