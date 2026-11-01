# Fiddy — 三条命令，在你自己的节点上跑你自己的 Farcaster 客户端

Fiddy 是一个可分叉（fork）的 Farcaster 客户端，支持外部钱包，读和写都通过**你自己的
Snapchain 读节点**完成——不需要 API key，不需要 Neynar，不需要 Alchemy。算力由你提供；
节点负责同步全网数据。

完整教程（手机 / 桌面，边做边讲协议概念）：
**https://fiddy.fun/client** —— 中文版：**https://fiddy.fun/client/zh** ——
或直接在本地打开 `site/index.html`。

本文是 README 关键章节（安装、跑读节点、跑客户端、常见问题）的中文译本。
命令名、参数、环境变量、端口号一律保持原文，未作改写。

## 快速开始

```bash
git clone https://github.com/ivcained/fiddy && cd fiddy

fiddy provision   # (0) 算力：用 aws CLI 开 AWS EC2，或者把任何一台服务器接进来（--ssh user@host）
fiddy node up     # (1) 在那台机器上跑 Snapchain 读节点 —— 安装、同步、等到健康
fiddy client up   # (2) Fiddy 网页客户端，读的是你自己的节点（默认走 SSH 隧道）
```

直接跑 `bin/fiddy`（`bash bin/fiddy …`）或把它放进 `PATH`。
`fiddy doctor` 检查本地前置条件；`fiddy node status` 报告同步健康度；
`fiddy client up --tunnel` 是默认行为，因为节点 API 不应该对外公开。

**发帖是免 gas 的。** 客户端会用你的托管地址签一条 `KEY_ADD` 消息，给自己发一把应用密钥——
不需要 ETH，不需要 Optimism 交易，大约一秒生效。导入一个**测试账号**的助记词（该账号已经付过
存储租金）：助记词从不离开你的浏览器，它只用来授权那把应用密钥。导入任何东西之前，先读
[助记词安全说明](https://fiddy.fun/client#safety)。

## 你会得到什么

- **你的读、你的写、你的基础设施** —— 信息流、cast、关注、点赞，以及是否显示其他客户端
  的 cast，全部由你自己的节点提供。
- **外部钱包，非托管** —— WalletConnect（EVM + Solana）、EIP-6963 自动发现、可选的
  Unified MetaMask Connect。除上面那次本地导入之外，客户端不创建、不索取、不保存助记词。
- **Fiddy Agent（可选）** —— 一次点击，在 Agent37 云上孵化属于你自己的 Hermes agent，
  它住在客户端里，可以接入你批准的每一个渠道。

## 跑一个读节点（命令 1）

```bash
fiddy node up       # 安装、启动、等 API 开始应答
fiddy node status   # 同步进度
fiddy node logs     # 跟进节点日志
```

读节点需要一台 **4 vCPU / 16 GB 内存 / 1.5–2 TB 可用磁盘**、Ubuntu 22.04+ 的服务器。
Snapchain 主网快照大约 **200 GB，那是压缩包的大小**——解压后要占掉好几倍的盘，所以请按
1.5–2 TB 规划，不要按 200 GB。同步需要几个小时；API 会立刻应答，然后在后台把历史追平。

## 跑客户端（命令 2）

```bash
fiddy client up --tunnel
```

如果你的节点 API 被锁在你的 IP 上（`--aws` 路径的默认行为），加上 `--tunnel`，
CLI 会为这次会话开一条 SSH 隧道。登录 = 给客户端它自己的一把密钥：客户端用你的托管地址
签一条免 gas 的 `KEY_ADD`，注册一把全新的 ed25519 应用密钥；此后托管密钥闲置，日常操作
都由应用密钥签名——权限有范围、有条数上限，随时可以用 `KEY_REMOVE` 吊销。

## 常见问题

| 问题 | 答案 |
| --- | --- |
| 要花 ETH 吗？ | 不要。自 Snapchain V16 起，应用密钥是免 gas 的 `KEY_ADD` 消息。你需要的是一个已经付过存储租金的账号。 |
| 我的节点能接收 cast 吗？ | 能——读节点会校验写入并 gossip 给验证者节点。它自己没有内存池，所以高负载下写入可能丢；盯 `MERGE_MESSAGE` 或把消息查回来，必要时重发。 |
| 应用密钥能做什么？ | 只能做你给它划定的那几类消息（cast、点赞、关注、用户资料）。密钥最迟 90 天滑动过期，每个 FID 最多 1000 把，用 `KEY_REMOVE` 即刻吊销。 |
| 托管密钥放在哪？ | 在你的浏览器里，只为那次 EIP-712 的 `KEY_ADD` 授权用一次，然后闲置。从不外发，也从不存到服务器上。 |
| 我依赖了谁？ | 依赖你的算力供应商保证机器在线，以及 Snapchain 验证者集合出块——和每个客户端依赖的是同一批人。读、写、身份工具全都在你自己手里。 |

故障排查的完整版本（命令报错、同步卡住、隧道断开）见教程正文
[你一定会撞上的问题](https://fiddy.fun/client/zh#faq)。

## 上流仓库（upstream）

本仓库源自 Farcaster client 单仓快照，并补上了外部钱包支持。钱包相关的英文细节见
[`apps/farcaster-web/README.md`](./apps/farcaster-web/README.md) 与
[`README.md`](./README.md)。

## 许可

MIT。