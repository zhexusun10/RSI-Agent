# OKX 模拟盘实验：已验证部分与待验证流程

## 已观察到的结果

- 实际 Cline/Pi Worker 在 Docker/bwrap 内通过官方 `@okx_ai/okx-trade-mcp@1.5.0`，以模拟模式读取了 `BTC-USDT` 公开行情。这不代表模拟账户或交易已验证。
- 未配置 API 凭据的情况下，官方 MCP 的 `account_get_balance` 本地报 `ConfigError`；能力信息显示 `account` 和 `spot` 为 `AUTH_MISSING`。请求未完成账户验证；不要声称收到了 OKX 的余额或订单。
- `rsi/scripts/okx-mock-order-smoke.mjs` 使用虚构凭据和回环地址假服务，跑通余额→限价下单→查单→撤单→查单。假服务校验了每次请求的 `x-simulated-trading: 1` 和 HMAC；最终假订单为 `canceled`。这是**本地模拟测试，不是 OKX 模拟盘成交**。复现需先执行 `npm install --prefix rsi/.artifacts/okx-mcp-validation --ignore-scripts @okx_ai/okx-trade-mcp@1.5.0`，再运行 `node rsi/scripts/okx-mock-order-smoke.mjs`。

## 真实模拟盘前提

在 OKX 模拟交易界面创建独立模拟盘 API Key，启用读取、交易，不启用提现；切勿使用实盘凭据。官方 MCP 的 `--demo` 控制私有交易工具的请求环境，不能假设每个交易工具都有单独的 `demo` 参数。确认账户模式、所属区域 API 域名和可用虚拟资产。使用者通过本地文件配置密钥，不写入 Markdown、日志或模型对话。

## 受控实验流程（尚未实测）

1. 确认使用模拟专用凭据、`--demo` 与正确区域；读取账户余额、交易产品规则和公开行情。
2. 根据交易产品的最小数量、价格步长和限价规则，构造一笔最小可用、低于买一价的现货限价买单；行情变化或价格保护可能使其成交或被拒绝，不承诺一定挂单。
3. 使用唯一 `clOrdId` 下单，记录脱敏的请求结果和时间。超时结果未知时，先按 `clOrdId` 查询，禁止盲目重复下单。
4. 查询状态；若仍未成交则撤单，随后再次查询直至确认终态。若已成交、部分成交或拒单，记录真实状态，不自动追加交易。
5. 再读账户或成交明细，核对结果；清理遗留模拟挂单，记录失败、限制和可复用工作流。没有账户和订单证据时，不宣称端到端通过。

参考：[OKX 模拟盘 API 文档](https://www.okx.com/docs-v5/zh/)；配置与安全限制见 `rsi/SETUP.txt`。
