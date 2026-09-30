import type { App } from 'obsidian';

export interface ErrorEntry {
    ts: number;
    source: string;
    message: string;
    stack?: string;
    pluginVersion: string;
    platform: string;
}

const MAX_ENTRIES = 50;
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;

export function redactText(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) {
        if (s && s.length >= 4 && out.includes(s)) {
            out = out.split(s).join('[REDACTED]');
        }
    }
    out = out.replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]');
    out = out.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
    return out;
}

export function toMessage(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
        return { message: error.message || error.name, stack: error.stack };
    }
    return { message: String(error) };
}

export class ErrorLogManager {
    private writeChain: Promise<void> = Promise.resolve();

    constructor(
        private app: App,
        private secretsProvider: () => string[] = () => [],
        private pluginVersion = 'dev',
        private platform = 'unknown'
    ) {}

    private get logPath(): string {
        return `${this.app.vault.configDir}/plugins/ray-vault-sync/error-log.json`;
    }

    async log(source: string, error: unknown): Promise<void> {
        const task = this.append(source, error).catch(() => undefined);
        this.writeChain = task;
        await task;
    }

    private async append(source: string, error: unknown): Promise<void> {
        const secrets = this.secretsProvider();
        const { message, stack } = toMessage(error);
        const entry: ErrorEntry = {
            ts: Date.now(),
            source,
            message: redactText(message.slice(0, MAX_MESSAGE), secrets),
            stack: stack ? redactText(stack.slice(0, MAX_STACK), secrets) : undefined,
            pluginVersion: this.pluginVersion,
            platform: this.platform
        };
        const entries = await this.readAll();
        entries.push(entry);
        const trimmed = entries.slice(-MAX_ENTRIES);
        const dir = this.logPath.substring(0, this.logPath.lastIndexOf('/'));
        try {
            if (!(await this.app.vault.adapter.exists(dir))) {
                await this.app.vault.adapter.mkdir(dir);
            }
        } catch {
            /* best effort */
        }
        await this.app.vault.adapter.write(this.logPath, JSON.stringify(trimmed));
    }

    async getRecent(n = 20): Promise<ErrorEntry[]> {
        const entries = await this.readAll();
        return entries.slice(-n).reverse();
    }

    async clear(): Promise<void> {
        try {
            if (await this.app.vault.adapter.exists(this.logPath)) {
                await this.app.vault.adapter.write(this.logPath, JSON.stringify([]));
            }
        } catch {
            /* best effort */
        }
    }

    async formatRecent(n = 20): Promise<string> {
        const entries = await this.getRecent(n);
        if (entries.length === 0) return 'No errors logged.';
        return entries
            .map((e) => `- [${new Date(e.ts).toISOString()}] ${e.source} (${e.platform} v${e.pluginVersion}): ${e.message}`)
            .join('\n');
    }

    private async readAll(): Promise<ErrorEntry[]> {
        try {
            if (!(await this.app.vault.adapter.exists(this.logPath))) return [];
            const raw = await this.app.vault.adapter.read(this.logPath);
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((e): e is ErrorEntry =>
                typeof e === 'object' && e !== null && typeof (e as ErrorEntry).ts === 'number'
            );
        } catch {
            return [];
        }
    }
}
