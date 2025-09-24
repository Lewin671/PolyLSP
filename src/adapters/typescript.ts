import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { LanguageAdapter, LanguageRegistrationContext } from '../types';

export function createTypeScriptAdapter(options: { tsserverPath: string }): LanguageAdapter {
    const tsserverPath = options.tsserverPath;

    let process: ChildProcess | null = null;
    let seq = 0;
    const pendingRequests = new Map<number, (result: any) => void>();
    let initialized = false;

    const startServer = () => {
        process = spawn('node', [tsserverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

        const rl = createInterface({ input: process.stdout! });

        rl.on('line', (line: string) => {
            if (line.trim() === '') return;
            try {
                const msg = JSON.parse(line);
                if (msg.request_seq !== undefined && pendingRequests.has(msg.request_seq)) {
                    pendingRequests.get(msg.request_seq)!(msg);
                    pendingRequests.delete(msg.request_seq);
                } else if (msg.event) {
                    // Handle events/notifications
                }
            } catch (e) {
                console.error('Error parsing tsserver message:', e);
            }
        });

        process.on('close', (code: number | null) => {
            console.log(`tsserver exited with code ${code}`);
            process = null;
        });
    };

    const sendCommand = async (command: string, args: any): Promise<any> => {
        if (!process) startServer();
        const request = { seq: ++seq, type: 'request', command, arguments: args };
        const message = JSON.stringify(request);
        process!.stdin!.write(message + '\n');
        return new Promise((resolve) => {
            pendingRequests.set(request.seq, resolve);
        });
    };

    const handlers = {
        initialize: async (ctx: LanguageRegistrationContext) => {
            await sendCommand('configure', {
                hostInfo: 'polylsp',
                preferences: {}, // Add prefs
            });
            initialized = true;
        },

        shutdown: async () => {
            if (initialized) {
                await sendCommand('exit', {});
            }
            if (process) process.kill();
        },

        getCompletions: (params: any) => sendCommand('completionInfo', params),
        getHover: (params: any) => sendCommand('quickinfo', params),
        getDefinition: (params: any) => sendCommand('definition', params),
        findReferences: (params: any) => sendCommand('references', params),
        getDocumentSymbols: (params: any) => sendCommand('navtree', params),
        renameSymbol: (params: any) => sendCommand('rename', params),
        formatDocument: (params: any) => sendCommand('format', params),

        // tsserver uses different commands, so map LSP to tsserver as needed
    };

    return {
        languageId: 'typescript',
        handlers,
    };
}
