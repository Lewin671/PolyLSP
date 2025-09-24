import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { LanguageAdapter, LanguageRegistrationContext } from '../types';

export function createGoAdapter(options: { goplsPath?: string } = {}): LanguageAdapter {
    const goplsPath = options.goplsPath || 'gopls';

    let process: ChildProcess | null = null;
    let requestId = 0;
    const pendingRequests = new Map<number, (result: any) => void>();
    let initialized = false;
    let buffer = '';

    const startServer = () => {
        process = spawn(goplsPath, ['-mode=stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

        let headerMode = true;
        let contentLength = 0;
        let messageBuffer = '';

        process.stdout!.on('data', (data: Buffer) => {
            buffer += data.toString();

            while (buffer.length > 0) {
                if (headerMode) {
                    const headerEnd = buffer.indexOf('\r\n\r\n');
                    if (headerEnd === -1) break;

                    const headers = buffer.substring(0, headerEnd);
                    buffer = buffer.substring(headerEnd + 4);

                    const lengthMatch = headers.match(/Content-Length: (\d+)/);
                    if (lengthMatch) {
                        contentLength = parseInt(lengthMatch[1]);
                        headerMode = false;
                    }
                } else {
                    if (buffer.length >= contentLength) {
                        const messageContent = buffer.substring(0, contentLength);
                        buffer = buffer.substring(contentLength);
                        headerMode = true;
                        contentLength = 0;

                        try {
                            const msg = JSON.parse(messageContent);
                            if (msg.id !== undefined && pendingRequests.has(msg.id)) {
                                const resolve = pendingRequests.get(msg.id)!;
                                pendingRequests.delete(msg.id);
                                if (msg.result !== undefined) {
                                    resolve(msg.result);
                                } else if (msg.error) {
                                    console.error('LSP Error:', msg.error);
                                    resolve(null);
                                } else {
                                    resolve(msg);
                                }
                            } else if (msg.method) {
                                // Handle notifications
                                console.log('LSP Notification:', msg.method);
                            }
                        } catch (e) {
                            console.error('Failed to parse LSP message:', e, messageContent);
                        }
                    } else {
                        break;
                    }
                }
            }
        });

        process.on('close', (code: number | null) => {
            console.log(`gopls exited with code ${code}`);
            process = null;
        });

        process.on('error', (error) => {
            console.error('gopls error:', error);
        });
    };

    const sendRequest = async (method: string, params: any): Promise<any> => {
        if (!process) startServer();
        const id = ++requestId;
        const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

        return new Promise((resolve) => {
            pendingRequests.set(id, resolve);
            if (process && process.stdin && !process.stdin.destroyed) {
                process.stdin.write(content);
            } else {
                resolve(null);
                return;
            }

            // Timeout after 5 seconds for faster test completion
            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    resolve(null);
                }
            }, 5000);
        });
    };

    const sendNotification = (method: string, params: any) => {
        if (!process) return;
        const message = JSON.stringify({ jsonrpc: '2.0', method, params });
        const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
        process.stdin!.write(content);
    };

    const handlers = {
        initialize: async (ctx: LanguageRegistrationContext) => {
            const workspaceFolder = ctx.options.workspaceFolders?.[0];
            const rootUri = workspaceFolder ? `file://${workspaceFolder}` : null;

            const result = await sendRequest('initialize', {
                processId: process?.pid || null,
                rootUri,
                capabilities: {
                    textDocument: {
                        synchronization: { dynamicRegistration: false },
                        completion: { dynamicRegistration: false },
                        hover: { dynamicRegistration: false },
                        definition: { dynamicRegistration: false },
                        references: { dynamicRegistration: false },
                        documentSymbol: { dynamicRegistration: false },
                        formatting: { dynamicRegistration: false },
                        rename: { dynamicRegistration: false }
                    },
                    workspace: {
                        workspaceFolders: true
                    }
                },
                workspaceFolders: workspaceFolder ? [{ uri: rootUri, name: 'workspace' }] : []
            });

            sendNotification('initialized', {});
            initialized = true;
            return result;
        },

        openDocument: (params: { uri: string; languageId: string; text: string; version: number }) => {
            sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri: params.uri,
                    languageId: params.languageId,
                    version: params.version,
                    text: params.text
                }
            });
        },

        closeDocument: (params: { uri: string }) => {
            sendNotification('textDocument/didClose', {
                textDocument: { uri: params.uri }
            });
        },

        shutdown: async () => {
            if (initialized) {
                try {
                    await Promise.race([
                        sendRequest('shutdown', {}),
                        new Promise(resolve => setTimeout(resolve, 2000)) // 2s timeout
                    ]);
                    sendNotification('exit', {});
                } catch (error) {
                    console.error('Error during gopls shutdown:', error);
                }
                initialized = false;
            }

            // Clear all pending requests
            for (const [id, resolve] of pendingRequests) {
                resolve(null);
            }
            pendingRequests.clear();

            if (process) {
                process.kill('SIGTERM');
                // Force kill after 1 second if still running
                setTimeout(() => {
                    if (process && !process.killed) {
                        process.kill('SIGKILL');
                        process = null;
                    }
                }, 1000);
            }
        },

        getCompletions: (params: any) => sendRequest('textDocument/completion', params),
        getHover: (params: any) => sendRequest('textDocument/hover', params),
        getDefinition: (params: any) => sendRequest('textDocument/definition', params),
        findReferences: (params: any) => sendRequest('textDocument/references', params),
        getDocumentSymbols: (params: any) => sendRequest('textDocument/documentSymbol', params),
        renameSymbol: (params: any) => sendRequest('textDocument/rename', params),
        formatDocument: (params: any) => sendRequest('textDocument/formatting', params),
    };

    return {
        languageId: 'go',
        handlers,
    };
}
