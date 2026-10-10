import { Notice, App } from 'obsidian';
import { GitHubClient } from './github-client';
import { LocalVault } from './local-vault';
import { SyncEngine } from './sync-core';
import { ErrorLogManager } from './error-log';
import { RayVaultSyncSettings } from './settings';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function appendLocalStatus(app: App, settings: RayVaultSyncSettings, report: string[]): Promise<boolean> {
    report.push('\n## Local Vault Status');
    try {
        const localVault = new LocalVault(app, settings.excludedPaths);
        const state = await localVault.getSyncState();
        report.push(`- Sync State File: Readable (Schema v${state?.schemaVersion || 1})`);
        report.push(`- Last Synced Commit: \`${state?.lastSyncedCommit || 'None (Needs Initial Sync)'}\``);

        const files = await localVault.getFiles();
        report.push(`- Local Tracked Files: ${files.length} files`);
        const conflicts = files.filter(file => file.path.includes('.conflict-'));
        report.push(`- Active Conflict Copies: ${conflicts.length}`);
        for (const conflict of conflicts) report.push(`  - \`${conflict.path}\``);
        return true;
    } catch (error: unknown) {
        report.push(`- Local Vault Error: ${errorMessage(error)}`);
        return false;
    }
}

async function appendGitHubStatus(settings: RayVaultSyncSettings, report: string[]): Promise<boolean> {
    report.push('\n## GitHub Connectivity Status');
    try {
        if (!settings.githubToken) throw new Error('GitHub token is empty. Please enter your PAT in settings.');
        if (!settings.repository) throw new Error('GitHub repository is empty. Please enter owner/repo in settings.');

        const client = new GitHubClient(settings.githubToken, settings.repository);
        const head = await client.getHeadCommit(settings.branch || 'main');
        report.push('- Authentication: Valid');
        report.push(`- Remote HEAD Commit: \`${head}\``);
        const tree = await client.getTree(head);
        report.push(`- Remote Tree Listing: Accessible (${tree.length} files tracked)`);
        return true;
    } catch (error: unknown) {
        report.push(`- GitHub Connection Error: ${errorMessage(error)}`);
        return false;
    }
}

async function appendPlanPreview(
    app: App,
    settings: RayVaultSyncSettings,
    report: string[]
): Promise<void> {
    report.push('\n## Synchronization Plan Preview');
    try {
        const engine = new SyncEngine(
            new LocalVault(app, settings.excludedPaths),
            new GitHubClient(settings.githubToken, settings.repository),
            settings.branch || 'main'
        );
        const { plan } = await engine.calculatePlan();
        const counts = {
            NOOP: plan.filter(item => item.action === 'NOOP').length,
            UPLOAD: plan.filter(item => item.action === 'UPLOAD').length,
            DOWNLOAD: plan.filter(item => item.action === 'DOWNLOAD').length,
            DELETE_LOCAL: plan.filter(item => item.action === 'DELETE_LOCAL').length,
            DELETE_REMOTE: plan.filter(item => item.action === 'DELETE_REMOTE').length,
            CONFLICT: plan.filter(item => item.action === 'CONFLICT').length
        };
        report.push(`- Files In Sync (NOOP): ${counts.NOOP}`);
        report.push(`- Pending Uploads: ${counts.UPLOAD}`);
        report.push(`- Pending Downloads: ${counts.DOWNLOAD}`);
        report.push(`- Pending Local Deletions: ${counts.DELETE_LOCAL}`);
        report.push(`- Pending Remote Deletions: ${counts.DELETE_REMOTE}`);
        report.push(`- Potential Conflicts: ${counts.CONFLICT}`);
    } catch (error: unknown) {
        report.push(`- Reconciler Error: ${errorMessage(error)}`);
    }
}

export async function runDiagnostics(
    app: App, 
    settings: RayVaultSyncSettings
): Promise<void> {
    new Notice('Ray Vault Sync: Running diagnostics...');
    const report: string[] = [];
    const push = (msg: string) => report.push(msg);

    push('# Ray Vault Sync - Diagnostics Report');
    push(`Generated at: ${new Date().toISOString()}`);

    const maskedToken = settings.githubToken 
        ? `${settings.githubToken.substring(0, 4)}...${settings.githubToken.substring(settings.githubToken.length - 4)}` 
        : 'NOT SET';
    
    push(`\n## Configuration`);
    push(`- Repository: \`${settings.repository || 'NOT SET'}\``);
    push(`- Branch: \`${settings.branch || 'main'}\``);
    push(`- Token: \`${maskedToken}\``);
    push(`- Auto-Sync: ${settings.autoSyncEnabled ? 'Enabled (' + settings.autoSyncInterval + ' mins)' : 'Disabled'}`);

    const localOk = await appendLocalStatus(app, settings, report);
    const githubOk = await appendGitHubStatus(settings, report);

    // Reconciler Preview
    if (localOk && githubOk) {
        await appendPlanPreview(app, settings, report);
    }

    push('\n---');
    push('Ray Vault Sync — Easy. Free. Seamless.');

    try {
        const errorLog = new ErrorLogManager(app, () => [settings.githubToken]);
        const recent = await errorLog.formatRecent(10);
        push(`\n## Recent Errors (redacted, local only)`);
        push('```');
        push(recent);
        push('```');
    } catch {
        /* best effort */
    }
    
    const reportPath = 'Sync Diagnostics.md';
    try {
        const localVault = new LocalVault(app, settings.excludedPaths);
        const encoder = new TextEncoder();
        await localVault.writeFile(reportPath, encoder.encode(report.join('\n')), false);
        
        const file = app.vault.getAbstractFileByPath(reportPath);
        if (file && 'extension' in file) { // Ensures it's a TFile
            await app.workspace.getLeaf(true).openFile(file as import('obsidian').TFile);
        }
        new Notice('Ray Vault Sync: Diagnostics complete! Report opened.');
    } catch (e: unknown) {
        const msg = errorMessage(e);
        new Notice(`Ray Vault Sync: Diagnostics failed to write report. ${msg}`);
    }
}
