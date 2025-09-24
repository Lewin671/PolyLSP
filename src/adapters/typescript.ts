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

        let buffer = '';
        process.stdout!.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();

            while (true) {
                const contentLengthMatch = buffer.match(/^Content-Length: (\d+)\r?\n\r?\n/);
                if (!contentLengthMatch) break;

                const contentLength = parseInt(contentLengthMatch[1], 10);
                const headerLength = contentLengthMatch[0].length;

                if (buffer.length < headerLength + contentLength) break;

                const messageContent = buffer.substring(headerLength, headerLength + contentLength);
                buffer = buffer.substring(headerLength + contentLength);

                try {
                    const msg = JSON.parse(messageContent);
                    if (msg.request_seq !== undefined && pendingRequests.has(msg.request_seq)) {
                        pendingRequests.get(msg.request_seq)!(msg);
                        pendingRequests.delete(msg.request_seq);
                    } else if (msg.event) {
                        // Handle events/notifications
                    }
                } catch (e) {
                    console.error('Error parsing tsserver message:', e);
                }
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

        getCompletions: async (params: any) => {
            // First, open the file
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('completionInfo', {
                file: params.textDocument.uri.replace('file://', ''),
                line: params.position.line + 1, // tsserver uses 1-based lines
                offset: params.position.character + 1 // tsserver uses 1-based characters
            });

            return {
                isIncomplete: false,
                items: result.body?.entries?.map((entry: any) => ({
                    label: entry.name,
                    kind: entry.kind === 'function' ? 3 : 6, // Function or Variable
                    detail: entry.kind
                })) || []
            };
        },

        getHover: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('quickinfo', {
                file: params.textDocument.uri.replace('file://', ''),
                line: params.position.line + 1,
                offset: params.position.character + 1
            });

            return {
                contents: result.body?.displayString ? [result.body.displayString] : []
            };
        },

        getDefinition: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('definition', {
                file: params.textDocument.uri.replace('file://', ''),
                line: params.position.line + 1,
                offset: params.position.character + 1
            });

            if (result.body?.[0]) {
                const def = result.body[0];
                return {
                    uri: `file://${def.file}`,
                    range: {
                        start: { line: def.start.line - 1, character: def.start.offset - 1 },
                        end: { line: def.end.line - 1, character: def.end.offset - 1 }
                    }
                };
            }
            return null;
        },

        findReferences: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('references', {
                file: params.textDocument.uri.replace('file://', ''),
                line: params.position.line + 1,
                offset: params.position.character + 1
            });

            return result.body?.refs?.map((ref: any) => ({
                uri: `file://${ref.file}`,
                range: {
                    start: { line: ref.start.line - 1, character: ref.start.offset - 1 },
                    end: { line: ref.end.line - 1, character: ref.end.offset - 1 }
                }
            })) || [];
        },

        getDocumentSymbols: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('navtree', {
                file: params.textDocument.uri.replace('file://', '')
            });

            const extractSymbols = (item: any): any[] => {
                const symbols = [];
                if (item.text && item.text !== '<global>') {
                    symbols.push({
                        name: item.text,
                        kind: item.kind === 'function' ? 12 : 13, // Function or Variable
                        range: item.spans?.[0] ? {
                            start: { line: item.spans[0].start.line - 1, character: item.spans[0].start.offset - 1 },
                            end: { line: item.spans[0].end.line - 1, character: item.spans[0].end.offset - 1 }
                        } : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
                    });
                }
                if (item.childItems) {
                    item.childItems.forEach((child: any) => {
                        symbols.push(...extractSymbols(child));
                    });
                }
                return symbols;
            };

            return result.body ? extractSymbols(result.body) : [];
        },

        renameSymbol: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('rename', {
                file: params.textDocument.uri.replace('file://', ''),
                line: params.position.line + 1,
                offset: params.position.character + 1
            });

            const changes: any = {};
            if (result.body?.locs) {
                result.body.locs.forEach((loc: any) => {
                    const uri = `file://${loc.file}`;
                    if (!changes[uri]) changes[uri] = [];
                    loc.locs.forEach((span: any) => {
                        changes[uri].push({
                            range: {
                                start: { line: span.start.line - 1, character: span.start.offset - 1 },
                                end: { line: span.end.line - 1, character: span.end.offset - 1 }
                            },
                            newText: params.newName
                        });
                    });
                });
            }

            return { changes };
        },

        formatDocument: async (params: any) => {
            await sendCommand('open', { file: params.textDocument.uri.replace('file://', '') });

            const result = await sendCommand('format', {
                file: params.textDocument.uri.replace('file://', ''),
                line: 1,
                offset: 1,
                endLine: 1000000, // Large number to format entire document
                endOffset: 1
            });

            return result.body || [];
        },

        // tsserver uses different commands, so map LSP to tsserver as needed
    };

    return {
        languageId: 'typescript',
        handlers,
    };
}
