import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { IGitHubClient, RemoteFile, GitTreeItem } from './interfaces';


export class GitHubClient implements IGitHubClient {
    private readonly baseUrl = 'https://api.github.com';

    constructor(
        private readonly token: string,
        private readonly repo: string // e.g. "owner/repo"
    ) {}
    private lastMutativeRequestTime = 0;

    private getRateLimitWaitSeconds(headers: Record<string, string>): number {
        const resetHeader = headers['x-ratelimit-reset'];
        const retryAfter = headers['retry-after'];
        if (retryAfter) return Number.parseInt(retryAfter, 10);
        if (resetHeader) {
            return Math.max(0, Number.parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000));
        }
        return 3600;
    }

    private getApiErrorMessage(response: RequestUrlResponse, waitSeconds: number): string {
        let errorMsg = `GitHub API Error: ${response.status}`;
        try {
            const errorData = response.json as { message?: string };
            if (errorData?.message) {
                if (errorData.message.includes('Resource not accessible by personal access token')) {
                    errorMsg = 'GitHub Token lacks "Contents: Read & write" permission for this repo.';
                } else if (errorData.message.includes('rate limit exceeded') || response.status === 403 || response.status === 429) {
                    errorMsg = `GitHub API Rate Limit exceeded. Will reset in ${waitSeconds}s.`;
                } else if (errorData.message.includes('Bad credentials')) {
                    errorMsg = 'Invalid GitHub Token (Expired or revoked).';
                } else if (errorData.message.includes('Not Found')) {
                    errorMsg = 'Repository not found. Check the repo name and token permissions.';
                } else {
                    errorMsg = `GitHub Error: ${errorData.message}`;
                }
            }
        } catch {
            if (response.status === 403 || response.status === 429) {
                errorMsg = `GitHub API Rate Limit exceeded. Will reset in ${waitSeconds}s.`;
            }
        }
        return errorMsg;
    }

    private async request<T = unknown>(endpoint: string, method: string = 'GET', body?: unknown): Promise<T> {
        // Anti-abuse: Ensure at least 1 second between mutative requests (GitHub Best Practices)
        if (method !== 'GET') {
            const elapsed = Date.now() - this.lastMutativeRequestTime;
            if (elapsed < 1000) {
                await new Promise(r => window.setTimeout(r, 1000 - elapsed));
            }
        }

        const req: RequestUrlParam = {
            url: `${this.baseUrl}/repos/${this.repo}${endpoint}`,
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined,
            throw: false
        };

        const response = await requestUrl(req);

        if (response.status >= 400) {
            const waitSeconds = this.getRateLimitWaitSeconds(response.headers);
            throw new Error(this.getApiErrorMessage(response, waitSeconds));
        }
        if (method !== 'GET') {
            this.lastMutativeRequestTime = Date.now();
        }

        return response.json as T;
    }

    public async getHeadCommit(branch: string): Promise<string> {
        const data = await this.request<{ object: { sha: string } }>(`/git/refs/heads/${branch}`);
        return data.object.sha;
    }

    public async getTree(commitSha: string): Promise<RemoteFile[]> {
        const data = await this.request<{ tree: { path: string; type: string; sha: string }[] }>(`/git/trees/${commitSha}?recursive=1`);
        return data.tree
            .filter((t) => t.type === 'blob')
            .map((t) => ({
                path: t.path,
                sha: t.sha,
                hash: t.sha // GitHub blob SHAs serve as stable hashes
            }));
    }

    public async getBlob(sha: string, isBinary: boolean): Promise<string | Uint8Array> {
        const data = await this.request<{ content: string }>(`/git/blobs/${sha}`);
        const base64Content = data.content.replace(/\n/g, ''); // GitHub returns base64 with newlines
        
        const binaryStr = atob(base64Content);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.codePointAt(i)!;
        }

        if (isBinary) {
            return bytes;
        }
        
        return new TextDecoder('utf-8').decode(bytes);
    }

    public async createTree(baseTreeSha: string, tree: GitTreeItem[]): Promise<string> {
        const data = await this.request<{ sha: string }>('/git/trees', 'POST', {
            base_tree: baseTreeSha,
            tree: tree
        });
        return data.sha;
    }

    public async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
        const data = await this.request<{ sha: string }>('/git/commits', 'POST', {
            message,
            tree: treeSha,
            parents
        });
        return data.sha;
    }

    public async updateRef(branch: string, commitSha: string, force: boolean = false): Promise<void> {
        await this.request(`/git/refs/heads/${branch}`, 'PATCH', {
            sha: commitSha,
            force
        });
    }

    public async createBlob(content: string | Uint8Array, isBinary: boolean): Promise<string> {
        const bytes = isBinary ? content as Uint8Array : new TextEncoder().encode(content as string);
        let binaryStr = '';
        for (const byte of bytes) {
            binaryStr += String.fromCodePoint(byte);
        }
        const encodedContent = btoa(binaryStr);

        const data = await this.request<{ sha: string }>('/git/blobs', 'POST', {
            content: encodedContent,
            encoding: 'base64'
        });
        return data.sha;
    }
}
