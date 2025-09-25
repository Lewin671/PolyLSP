import { ChildProcess, spawn } from 'child_process';
import { TextDecoder } from 'util';
import { DocumentChange, LanguageAdapter, LanguageRegistrationContext } from '../types';

export function createGoAdapter(options: { goplsPath?: string } = {}): LanguageAdapter {
    const goplsPath = options.goplsPath || 'gopls';

    let process: ChildProcess | null = null;
    let requestId = 0;
    const pendingRequests = new Map<number, (result: any) => void>();
    let initialized = false;
    let registrationContext: LanguageRegistrationContext | null = null;
    const decoder = new TextDecoder('utf-8');
    let buffer = new Uint8Array(0);

    const startServer = () => {
        process = spawn(goplsPath, ['-mode=stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

        let headerMode = true;
        let contentLength = 0;
        process.stdout!.on('data', (data: Buffer) => {
            const incoming = new Uint8Array(data);
            const combined = new Uint8Array(buffer.length + incoming.length);
            combined.set(buffer);
            combined.set(incoming, buffer.length);
            buffer = combined;

            while (buffer.length > 0) {
                if (headerMode) {
                    let headerEnd = -1;
                    for (let i = 0; i <= buffer.length - 4; i++) {
                        if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
                            headerEnd = i;
                            break;
                        }
                    }
                    if (headerEnd === -1) break;

                    const headerBuffer = buffer.slice(0, headerEnd);
                    buffer = buffer.slice(headerEnd + 4);

                    const headers = decoder.decode(headerBuffer);
                    const lengthMatch = headers.match(/Content-Length: (\d+)/i);
                    if (lengthMatch) {
                        contentLength = parseInt(lengthMatch[1], 10);
                        headerMode = false;
                    }
                } else {
                    if (buffer.length < contentLength) {
                        break;
                    }

                    const messageBuffer = buffer.slice(0, contentLength);
                    buffer = buffer.slice(contentLength);
                    headerMode = true;
                    contentLength = 0;

                    try {
                        const messageContent = decoder.decode(messageBuffer);
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
                            if (msg.method === 'textDocument/publishDiagnostics' && registrationContext) {
                                const params = msg.params ?? {};
                                const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
                                registrationContext.publishDiagnostics(params.uri, diagnostics);
                            } else if (registrationContext) {
                                registrationContext.notifyClient(msg.method, msg.params ?? {});
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse LSP message:', e);
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
            registrationContext = ctx;
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

        updateDocument: (params: {
            uri: string;
            languageId: string;
            version: number;
            text: string;
            changes: DocumentChange[];
        }) => {
            const contentChanges = Array.isArray(params.changes) && params.changes.length > 0
                ? params.changes.map((change) => {
                    if (change.range) {
                        return { range: change.range, text: change.text };
                    }
                    return { text: change.text };
                })
                : [{ text: params.text }];
            sendNotification('textDocument/didChange', {
                textDocument: {
                    uri: params.uri,
                    version: params.version,
                },
                contentChanges,
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
            registrationContext = null;
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
