import { Notice, App } from 'obsidian';
import { GitHubClient } from './github-client';
import { LocalVault } from './local-vault';
import { SyncEngine } from './sync-core';
import { RayVaultSyncSettings } from './settings';

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
    push(`- Auto-Sync: ${settings.autoSyncEnabled ? `Enabled (${settings.autoSyncInterval} mins)` : 'Disabled'}`);

    let githubOk = false;
    let localOk = false;

    // Check Local Vault
    push(`\n## Local Vault Status`);
    try {
        const localVault = new LocalVault(app, settings.excludedPaths);
        const state = await localVault.getSyncState();
        push(`- Sync State File: Readable (Schema v${state?.schemaVersion || 1})`);
        push(`- Last Synced Commit: \`${state?.lastSyncedCommit || 'None (Needs Initial Sync)'}\``);
        
        const files = await localVault.getFiles();
        push(`- Local Tracked Files: ${files.length} files`);
        
        const conflicts = files.filter(f => f.path.includes('.conflict-'));
        push(`- Active Conflict Copies: ${conflicts.length}`);
        if (conflicts.length > 0) {
            conflicts.forEach(c => push(`  - \`${c.path}\``));
        }
        
        localOk = true;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        push(`- Local Vault Error: ${msg}`);
    }

    // Check GitHub Access
    push(`\n## GitHub Connectivity Status`);
    try {
        if (!settings.githubToken) throw new Error("GitHub token is empty. Please enter your PAT in settings.");
        if (!settings.repository) throw new Error("GitHub repository is empty. Please enter owner/repo in settings.");

        const gh = new GitHubClient(settings.githubToken, settings.repository);
        const head = await gh.getHeadCommit(settings.branch || 'main');
        push(`- Authentication: Valid`);
        push(`- Remote HEAD Commit: \`${head}\``);
        
        const tree = await gh.getTree(head);
        push(`- Remote Tree Listing: Accessible (${tree.length} files tracked)`);
        
        githubOk = true;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        push(`- GitHub Connection Error: ${msg}`);
    }

    // Reconciler Preview
    if (localOk && githubOk) {
        push(`\n## Synchronization Plan Preview`);
        try {
            const engine = new SyncEngine(new LocalVault(app, settings.excludedPaths), new GitHubClient(settings.githubToken, settings.repository), settings.branch || 'main');
            const { plan } = await engine.calculatePlan();
            
            const uploads = plan.filter(p => p.action === 'UPLOAD').length;
            const downloads = plan.filter(p => p.action === 'DOWNLOAD').length;
            const deletesL = plan.filter(p => p.action === 'DELETE_LOCAL').length;
            const deletesR = plan.filter(p => p.action === 'DELETE_REMOTE').length;
            const conflicts = plan.filter(p => p.action === 'CONFLICT').length;
            const noops = plan.filter(p => p.action === 'NOOP').length;

            push(`- Files In Sync (NOOP): ${noops}`);
            push(`- Pending Uploads: ${uploads}`);
            push(`- Pending Downloads: ${downloads}`);
            push(`- Pending Local Deletions: ${deletesL}`);
            push(`- Pending Remote Deletions: ${deletesR}`);
            push(`- Potential Conflicts: ${conflicts}`);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            push(`- Reconciler Error: ${msg}`);
        }
    }

    push('\n---');
    push('Ray Vault Sync — Easy. Free. Seamless.');
    
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
        const msg = e instanceof Error ? e.message : String(e);
        new Notice(`Ray Vault Sync: Diagnostics failed to write report. ${msg}`);
    }
}
