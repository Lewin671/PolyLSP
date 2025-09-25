# PolyLSP

PolyLSP 是一个面向多语言的 LSP（Language Server Protocol）客户端实现，专注于为 TypeScript/JavaScript 生态提供统一、可扩展的接口，方便上层框架或工具快速集成多语言智能能力。

## 核心特性
- **跨语言支持**：通过统一的客户端管理多个语言服务器，开箱即用地支持常见语言，并支持自定义适配器扩展。
- **TypeScript 优先的 API 设计**：暴露完备的 TS 类型定义，便于在 TS/JS 项目中获得编译期提示与类型保障。
- **模块化架构**：将连接管理、能力协商、文档同步、诊断处理等逻辑拆分为独立模块，减少耦合，便于替换与扩展。
- **事件驱动的数据流**：使用可组合的事件流机制，让调用方能够监听/订阅语言服务回调（诊断、补全、跳转等）。
- **框架无关性**：可嵌入到 CLI 工具、VS Code 插件、Web IDE 或后端服务中，无需依赖特定运行时。
- **统一传输层抽象**：内置基于 JSON-RPC 的复用连接管理器，适配器仅需关心命令行参数与协议扩展，即可获得可靠的消息解析、请求排队与超时控制。
- **健壮的生命周期管理**：完善语言注册状态机与文档同步逻辑，确保初始化失败、重试或进程崩溃时资源得到正确回收。

## 暴露的 TS API 规划
> 下列接口命名基于规划中的核心实现，后续将以 `packages/core` 提供完整类型定义。调用方可通过这些 API 驱动常见 LSP 能力，同时保留向下兼容的原生请求通道。

- **客户端生命周期**
  - `createPolyClient(options)`：创建并初始化多语言客户端。
  - `client.dispose()`：关闭所有语言服务器连接与监听。
- **多语言管理**
  - `registerLanguage(client, adapter)` / `unregisterLanguage(languageId)`：动态注册/移除语言服务器适配器。
  - `client.listLanguages()`：列出已注册语言、能力与运行状态。
- **文档同步**
  - `client.openDocument({ uri, languageId, text, version })`
  - `client.updateDocument({ uri, version, changes })`
  - `client.closeDocument(uri)`
- **语言能力请求**（覆盖 LSP 常用方法）
  - `client.getCompletions(params)` → `CompletionList`
  - `client.getHover(params)` → `Hover`
  - `client.getDefinition(params)` → `Location | Location[]`
  - `client.findReferences(params)` → `Location[]`
  - `client.getCodeActions(params)` → `CodeAction[]`
  - `client.getDocumentHighlights(params)` → `DocumentHighlight[]`
  - `client.getDocumentSymbols(params)` → `DocumentSymbol[]`
  - `client.renameSymbol(params)` → `WorkspaceEdit`
  - `client.formatDocument(params)` / `client.formatRange(params)` → `TextEdit[]`
- **工作区与诊断**
  - `client.onDiagnostics(uri, listener)`：订阅 `textDocument/publishDiagnostics`。
  - `client.applyWorkspaceEdit(edit)`：与语言服务器协作完成跨文件修改。
  - `client.onWorkspaceEvent(kind, listener)`：监听 `workspace/didChangeConfiguration` 等通知。
  - `client.onError(listener)`：捕获适配器执行失败、进程退出等错误，便于上层统一处理。
- **低层扩展能力**
  - `client.sendRequest(method, params)` / `client.sendNotification(method, params)`：直接转发自定义 LSP 扩展。
  - `client.onNotification(method, listener)`：监听扩展通知，方便适配 Language Server 自定义特性。

> 从本版本开始，`sendRequest`/`sendNotification` 会在多语言同时在线时强制要求显式的 `languageId` 或文档 URI，以避免请求被错误路由到其他语言服务器。

## 传输层与适配器复用

- 新增 `JsonRpcConnection` 工具类封装了 Content-Length 帧解析、请求/响应匹配、超时控制与错误传播逻辑，TypeScript 与 Go 适配器均复用该组件，消除了过去重复实现的缓冲区拼接与队列管理代码。
- 适配器在初始化阶段会自动排队文档同步与通知请求；当语言服务器准备就绪后，PolyClient 会按顺序冲洗队列，避免初始化过程中丢失 `didOpen`/`didChange`。
- 初始化失败会触发 `onError` 事件，并保证执行 `shutdown`/`dispose` 清理流程，防止残留子进程或事件监听。
- `applyWorkspaceEdit` 现会将增量 `TextEdit` 转换为对应的 `DocumentChange`，确保语言服务器与本地文本版本保持一致；`updateDocument` 允许空变更用于仅更新版本号的场景。

## 快速开始
> 当前仓库处于初始化阶段，以下示例展示了规划中的使用方式，便于对整体 API 有直观认识。

### 安装
```bash
npm install polylsp
# or
yarn add polylsp
```

### 基本用法
```ts
import { createPolyClient, registerLanguage } from "polylsp";
import { createTypeScriptAdapter } from "polylsp/adapters/typescript";
import { pythonAdapter } from "polylsp/adapters/python";

const client = await createPolyClient({
  transport: "stdio",          // 支持 stdio、socket、websocket 等模式
  workspaceFolders: ["./src"],
});

registerLanguage(client, createTypeScriptAdapter());

// TypeScript 适配器会自动调用 `typescript-language-server --stdio`
//（需将 `typescript-language-server` 安装为依赖），无需额外的路径配置。

registerLanguage(client, pythonAdapter({
  command: "pyright-langserver",
}));

await client.openDocument({
  uri: "file:///Users/me/project/src/index.ts",
  languageId: "typescript",
  version: 1,
  text: "const message: string = 'hello';\n",
});

const completions = await client.getCompletions({
  uri: "file:///Users/me/project/src/index.ts",
  position: { line: 0, character: 21 },
});

console.log(completions.items.map(item => item.label));
```

### 与现有工具集成
- **CLI/脚本**：在批量代码分析、自动修复脚本中使用 PolyLSP 获取诊断与补全建议。
- **编辑器插件**：将 PolyLSP 封装为插件后端，实现统一的多语言支持逻辑。
- **Web IDE**：结合 WebSocket transport，将语言服务能力引入浏览器端代码编辑器。

## 架构概览
```
+--------------------+
|      PolyLSP       |
|                    |
|  +--------------+  |       +--------------------+
|  | Transport    |--------------> Language Server|
|  +--------------+  |       +--------------------+
|  | Session Mgmt |  |
|  +--------------+  |
|  | Capability   |  |
|  | Negotiator   |  |
|  +--------------+  |
|  | Event Bus    |  |
|  +--------------+  |
+--------------------+
```
- **Transport 层**：负责不同进程/网络模式下的通信抽象。
- **Session 管理**：维护文档生命周期、同步版本和请求缓存。
- **能力协商**：与语言服务器进行初始化和动态能力协商。
- **事件总线**：对外暴露标准事件，供调用方订阅诊断、补全等回调。

## 目录规划（草案）
```
.
├─ packages/
│  ├─ core/                 # 核心客户端实现
│  ├─ transports/           # 不同传输协议适配
│  ├─ adapters/             # 具体语言服务器适配器
│  └─ utils/                # 公共工具
├─ examples/                # 集成示例（CLI、VSCode、Web）
└─ docs/                    # 设计说明与 API 文档
```

## 开发计划
- [ ] 搭建基础 monorepo 结构与打包流程（可选 pnpm/workspaces）。
- [ ] 实现核心 LSP 连接与请求调度逻辑。
- [ ] 提供 TypeScript 语言适配器示例（基于 typescript-language-server）。
- [ ] 引入诊断、补全、跳转等高优先级特性。
- [ ] 编写自动化测试（协议兼容性、事件流、集成测试）。
- [ ] 编写文档网站与 API 参考。

## 参与贡献
欢迎通过 issue 或 PR 讨论架构与实现细节。建议遵循以下流程：
1. 提前在 issue 中同步实现计划，避免重复劳动。
2. 更新/添加相关测试，确保多语言用例覆盖。
3. 提供清晰的变更说明，方便维护者 review。

## 参考资料
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/specifications/specification-current/)
- [VS Code LSP Client](https://github.com/microsoft/vscode-languageserver-node)

---

PolyLSP 旨在降低多语言智能能力集成的门槛，让开发者可以专注于应用本身的体验与创新。如有建议或需求，欢迎提交反馈。
