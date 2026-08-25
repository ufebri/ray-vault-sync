import { IGitHubClient, RemoteFile } from './interfaces';

export class GitHubClient implements IGitHubClient {
    private baseUrl = 'https://api.github.com';

    constructor(
        private token: string,
        private repo: string // e.g. "owner/repo"
    ) {}

    private async request(endpoint: string, method: string = 'GET', body?: any) {
        const response = await fetch(`${this.baseUrl}/repos/${this.repo}${endpoint}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (!response.ok) {
            let errorMsg = `GitHub API Error: ${response.status} ${response.statusText}`;
            try {
                const errorData = await response.json();
                if (errorData.message) {
                    if (errorData.message.includes('Resource not accessible by personal access token')) {
                        errorMsg = 'GitHub Token lacks "Contents: Read & write" permission for this repo.';
                    } else if (errorData.message.includes('rate limit exceeded')) {
                        errorMsg = 'GitHub API Rate Limit exceeded. Please wait 1 hour.';
                    } else if (errorData.message.includes('Bad credentials')) {
                        errorMsg = 'Invalid GitHub Token (Expired or revoked).';
                    } else if (errorData.message.includes('Not Found')) {
                        errorMsg = 'Repository not found. Check the repo name and token permissions.';
                    } else {
                        errorMsg = `GitHub Error: ${errorData.message}`;
                    }
                }
            } catch (e) {}
            throw new Error(errorMsg);
        }

        return response.json();
    }

    public async getHeadCommit(branch: string): Promise<string> {
        const data = await this.request(`/git/refs/heads/${branch}`);
        return data.object.sha;
    }

    public async getTree(commitSha: string): Promise<RemoteFile[]> {
        const data = await this.request(`/git/trees/${commitSha}?recursive=1`);
        return data.tree
            .filter((t: any) => t.type === 'blob')
            .map((t: any) => ({
                path: t.path,
                sha: t.sha,
                hash: t.sha // GitHub blob SHAs serve as stable hashes
            }));
    }

    public async getBlob(sha: string, isBinary: boolean): Promise<string | Uint8Array> {
        const data = await this.request(`/git/blobs/${sha}`);
        const content = atob(data.content);
        if (isBinary) {
            const arr = new Uint8Array(content.length);
            for (let i = 0; i < content.length; i++) {
                arr[i] = content.charCodeAt(i);
            }
            return arr;
        }
        return decodeURIComponent(escape(content));
    }

    public async createTree(baseTreeSha: string, tree: any[]): Promise<string> {
        const data = await this.request('/git/trees', 'POST', {
            base_tree: baseTreeSha,
            tree: tree
        });
        return data.sha;
    }

    public async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
        const data = await this.request('/git/commits', 'POST', {
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
        let encoding = 'utf-8';
        let encodedContent = content as string;

        if (isBinary) {
            encoding = 'base64';
            const arr = content as Uint8Array;
            let binaryStr = '';
            for (let i = 0; i < arr.byteLength; i++) {
                binaryStr += String.fromCharCode(arr[i]);
            }
            encodedContent = btoa(binaryStr);
        } else {
            // Text to base64 to ensure API handles UTF-8 / non-ASCII safely
            encoding = 'base64';
            encodedContent = btoa(unescape(encodeURIComponent(content as string)));
        }

        const data = await this.request('/git/blobs', 'POST', {
            content: encodedContent,
            encoding
        });
        return data.sha;
    }
}
