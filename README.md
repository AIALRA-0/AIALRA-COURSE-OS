<h1 align="center">Course OS</h1>

把课件编译成可核验讲解、形成性测验和长期掌握记录，再通过左图右文播放器完成学习

[English](README.en.md) · [架构](docs/architecture.md) · [本地开发](docs/runbooks/local-development.md) · [部署](docs/runbooks/deployment.md) · [安全](SECURITY.md)

当前版本为 `2.4.0` 受控个人预览，处于大型收尾阶段，不是公开多用户产品，也不宣称完整生产 `1.0`

![Course OS 左图右文合成演示界面](docs/assets/course-os-player-synthetic.svg)

仓库只包含 Apache-2.0 源码和合成测试资料，真实课件、页面图片、学习记录、数据库、日志、主机配置、域名和秘密都不属于公开源码树

## 1. 2.4 能力边界

- 不可变课程 release 和 `ReleaseManifest` 固定来源、页面、讲解、测验、Writing Policy、模型、质量与成本版本
- 正式课程树排除 synthetic、legacy、回归夹具、其他工作区和草稿来源
- 页面、问答、题库、掌握状态、复习计划与随机题受工作区和固定 release 约束
- 鼠标、触摸与键盘都可操作课程树，页码、缩放、平移与固定 release 可恢复
- 左侧同一时刻只显示一个教学视觉，右侧负责讲解、KaTeX、伪代码逐行说明、提问和测验
- ReadWeave 是语义权威，写入带 `Idempotency-Key`、`X-Actor`、`X-Workspace-Id`、`X-Request-Id` 与 `X-Schema-Version`
- ReadWeave 故障向浏览器返回受控错误，不下发 token、原始远端响应或服务器细节

私有验收基线由 Introduction v4 的 25 页与 Chapter 2 v5 的 47 页组成，共 72 页，这些内容和截图不会进入本仓库

## 2. 快速开始

需要 Node.js 24 和 pnpm 10

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm seed:synthetic
pnpm --filter @course-os/api start
```

另开终端

```powershell
pnpm --filter @course-os/web dev
```

浏览器打开终端显示的本地地址并选择合成课程，合成路径不需要模型密钥，也不会读取私有课件

## 3. 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm verify:course
pnpm verify:tree
pnpm verify:routes
pnpm verify:writing
pnpm verify:public
```

`verify:writing` 始终核对版本化策略清单，只有设置 `HUMAN_READABLE_SKILL_DIR` 时，它才额外核对私有策略源文件哈希，公开 CI 不依赖任何本机绝对路径

## 4. ReadWeave 状态提升

运维脚本默认只读

```powershell
pnpm promote:readweave
```

只有人工复核 dry-run、验证备份与回滚点后，才可显式执行 `pnpm promote:readweave -- --apply`，脚本只创建缺失 release 或 draft，同 ID 或同页面不同哈希会立即停止，不删除、不覆盖远端草稿，也不允许用本地状态文件替换远端权威数据

## 5. 部署模型

公开仓库提供变量化 Compose 与 Nginx 模板，真实主机名、认证回调、VPS 路径、网络名、环境文件和秘密只保存在运行环境，每次部署都从公开 `main` 的精确提交构建以下不可变镜像

- `course-os-runtime:2.4.0-<short-sha>`
- `course-os-converter:2.4.0-<short-sha>`

磁盘可用空间不足 40 GB、公开发布门拒绝、ReadWeave 认证失败、哈希冲突、备份或回滚点无法验证、线上健康失败时必须停止

## 6. 非目标

2.4 收尾不扩展多 Agent 课堂、语音、自动教学 PPT、论文轨道、公开多用户、LMS 或新的基础设施

## 7. 许可

Course OS 源码使用 [Apache-2.0](LICENSE)，ReadWeave 作为独立服务运行，私有课程材料不受本仓库源码许可授权
