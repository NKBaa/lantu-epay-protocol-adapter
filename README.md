# 蓝兔支付 ePay 协议转换层

这个服务对 `newapi` 暴露易支付兼容接口，对内调用蓝兔支付接口。`newapi` 侧商户号和商户密钥直接填写蓝兔支付的商户号和密钥，只需要把易支付网关地址替换成转换层地址。

## 支持接口

- `GET|POST /submit.php`：易支付下单入口，支持 `alipay`、`wxpay`。
- `POST /lantu/notify`：蓝兔支付异步通知入口，校验蓝兔签名后转发为易支付通知。
- `GET /return`：易支付同步跳转入口。
- `GET|POST /api.php?act=order&pid=...&out_trade_no=...&sign=...&sign_type=MD5`：订单查询。

## Docker Compose 部署

默认本地构建镜像：

```bash
cd lantu-epay-adapter-v2
docker compose up -d --build
```

配置直接写在 `docker-compose.yml` 的 `environment` 里，部署前修改这些值：

```yaml
environment:
  PORT: "18080"
  PUBLIC_BASE_URL: "https://pay-adapter.example.com"
  LANTU_MCH_ID: "1230000109"
  LANTU_KEY: "change_me_lantu_key"
```

Compose 默认使用 `network_mode: host`，`PORT` 就是宿主机监听端口，不需要 `ports` 映射。

也可以直接使用 GitHub Container Registry 镜像：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

启动后查看状态：

```bash
docker compose ps
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
cd lantu-epay-adapter-v2
docker build -t lantu-epay-adapter-v2:latest .
docker run -d --name lantu-epay-adapter-v2 --restart unless-stopped --network host -e PORT=18080 -e PUBLIC_BASE_URL=https://pay-adapter.example.com -e LANTU_MCH_ID=1230000109 -e LANTU_KEY=change_me_lantu_key lantu-epay-adapter-v2:latest
```

## GitHub 镜像构建

推送到 `main` 或创建 `v*` 标签时，GitHub Actions 会自动构建并推送镜像到：

```text
ghcr.io/nkbaa/lantu-epay-adapter-v2:latest
```

同时会生成分支、标签和提交 SHA 镜像标签，例如：

```text
ghcr.io/nkbaa/lantu-epay-adapter-v2:main
ghcr.io/nkbaa/lantu-epay-adapter-v2:sha-xxxxxxx
```

## 裸机开发启动

```bash
cd lantu-epay-adapter-v2
npm install
cp .env.example .env
npm start
```

## newapi 配置

- 支付类型选择易支付/ePay。
- 商户号填写蓝兔支付商户号，也就是 Compose `environment` 中的 `LANTU_MCH_ID`。
- 商户密钥填写蓝兔支付密钥，也就是 Compose `environment` 中的 `LANTU_KEY`。
- 支付网关填写转换层公网地址，例如 `https://pay-adapter.example.com/`。
- 除网关地址外，不需要额外维护一套 ePay 商户号或密钥。
- 如果 Docker 前面有 Nginx/Caddy，反代到 `127.0.0.1:18080`，或你在 `PORT` 中配置的端口。

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
