import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { LanguageAdapter, LanguageRegistrationContext } from '../types';

export function createGoAdapter(options: { goplsPath?: string } = {}): LanguageAdapter {
    const goplsPath = options.goplsPath || 'gopls'; // Assume in PATH

    let process: ChildProcess | null = null;
    let requestId = 0;
    const pendingRequests = new Map<number, (result: any) => void>();
    let initialized = false;

    const startServer = () => {
        process = spawn(goplsPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });

        const rl = createInterface({ input: process.stdout! });

        rl.on('line', (line: string) => {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && pendingRequests.has(msg.id)) {
                    pendingRequests.get(msg.id)!(msg);
                    pendingRequests.delete(msg.id);
                } else if (msg.method) {
                    // Handle notifications if needed
                }
            } catch (e) {
                console.error('Error parsing LSP message:', e);
            }
        });

        process.on('close', (code: number | null) => {
            console.log(`gopls exited with code ${code}`);
            process = null;
        });
    };

    const sendRequest = async (method: string, params: any): Promise<any> => {
        if (!process) startServer();
        const id = ++requestId;
        const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        process!.stdin!.write(message + '\n');
        return new Promise((resolve) => {
            pendingRequests.set(id, resolve);
        });
    };

    const handlers = {
        initialize: async (ctx: LanguageRegistrationContext) => {
            await sendRequest('initialize', {
                processId: process!.pid,
                rootUri: ctx.options.workspaceFolders?.[0] || null,
                capabilities: {}, // Add capabilities as needed
            });
            await sendRequest('initialized', {});
            initialized = true;
        },

        shutdown: async () => {
            if (initialized) {
                await sendRequest('shutdown', {});
                await sendRequest('exit', {});
            }
            if (process) process.kill();
        },

        getCompletions: (params: any) => sendRequest('textDocument/completion', params),
        getHover: (params: any) => sendRequest('textDocument/hover', params),
        getDefinition: (params: any) => sendRequest('textDocument/definition', params),
        findReferences: (params: any) => sendRequest('textDocument/references', params),
        getDocumentSymbols: (params: any) => sendRequest('textDocument/documentSymbol', params),
        renameSymbol: (params: any) => sendRequest('textDocument/rename', params),
        formatDocument: (params: any) => sendRequest('textDocument/formatting', params),

        // Add more handlers as needed
    };

    return {
        languageId: 'go',
        handlers,
    };
}
