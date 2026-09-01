# 本地开发手册

## 1 安全默认路径

合成演示不读取私有课件、不调用模型、不访问外部 URL，也不需要真实密钥

## 2 启动步骤

- 第一步，安装依赖：

  ```powershell
  corepack enable # 启用仓库声明的 pnpm
  pnpm install # 安装全部工作区依赖
  ```

- 第二步，建立合成课程：

  ```powershell
  pnpm seed:synthetic # 写入可重复执行的合成发布
  ```

- 第三步，启动 API：

  ```powershell
  pnpm --filter @course-os/api start # 默认监听 127.0.0.1:4100
  ```

- 第四步，启动网页：

  ```powershell
  pnpm --filter @course-os/web dev # 使用终端打印的本地地址
  ```

- 第五步，核对结果：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:4100/healthz # 应返回 status=ok 和 API 版本
  ```

## 3 私有 EE680 路径

`EE680_SOURCE_DIR` 必须指向仓库外目录；种子脚本只把字节写入被 Git 忽略的 `var/cas`

不要复制、移动或提交原始课程材料

## 4 停止与清理

停止终端进程不会删除课程发布

`var` 包含本地课程、问答和掌握记录；删除前必须先确认不需要恢复，当前手册不提供自动删除命令
