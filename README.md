# 蓝兔支付 ePay 协议转换层

这个服务对 `newapi` 暴露易支付兼容接口，对内调用蓝兔支付接口。`newapi` 侧商户号和商户密钥直接填写蓝兔支付的商户号和密钥，只需要把易支付网关地址替换成转换层地址。

## 支持接口

- `GET|POST /submit.php`：易支付下单入口，支持 `alipay`、`wxpay`。
- `POST /lantu/notify`：蓝兔支付异步通知入口，校验蓝兔签名后转发为易支付通知。
- `GET /return`：易支付同步跳转入口。
- `GET|POST /api.php?act=order&pid=...&out_trade_no=...&sign=...&sign_type=MD5`：订单查询。
- `GET /healthz`：健康检查。

## Docker Compose 部署

```bash
cd lantu-epay-adapter
cp .env.example .env
docker compose up -d --build
```

启动后检查：

```bash
docker compose ps
curl http://127.0.0.1:3000/healthz
```

更新代码后重新构建：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

停止服务：

```bash
docker compose down
```

## Docker 手动部署

```bash
cd lantu-epay-adapter
docker build -t lantu-epay-adapter:latest .
docker run -d --name lantu-epay-adapter --restart unless-stopped --env-file .env -p 3000:3000 lantu-epay-adapter:latest
```

## 裸机开发启动

```bash
cd lantu-epay-adapter
npm install
cp .env.example .env
npm start
```

## newapi 配置

- 支付类型选择易支付/ePay。
- 商户号填写蓝兔支付商户号，也就是 `.env` 中的 `LANTU_MCH_ID`。
- 商户密钥填写蓝兔支付密钥，也就是 `.env` 中的 `LANTU_KEY`。
- 支付网关填写转换层公网地址，例如 `https://pay-adapter.example.com/`。
- 除网关地址外，不需要额外维护一套 ePay 商户号或密钥。
- 如果 Docker 前面有 Nginx/Caddy，反代到容器端口 `3000`。

## 回调地址

转换层会把 `newapi` 传入的 `notify_url` 放入蓝兔 `attach`，蓝兔只需要回调：

```text
https://pay-adapter.example.com/lantu/notify
```

## 协议映射

| 易支付字段 | 蓝兔字段 |
| --- | --- |
| `out_trade_no` | `out_trade_no` |
| `money` | `total_fee` |
| `name` | `body` |
| `type=wxpay` | `/api/wxpay/{mode}` |
| `type=alipay` | `/api/alipay/{mode}` |
| `notify_url` | 写入 `attach`，蓝兔回调转换层后再通知 `newapi` |
| `return_url` | 蓝兔 `return_url`，不可用时由 `/return` 兜底 |

## 注意

- 蓝兔文档要求 `notify_url` 不能携带查询参数，所以转换层用 `attach` 保存原始 `newapi notify_url`。
- 订单状态保存在内存中，单实例可直接使用；生产多实例或重启不丢单时，应把 `orders` 替换为 Redis/数据库。
- 易支付通知成功要求下游返回 `success`；蓝兔通知成功要求本服务返回 `SUCCESS`。
