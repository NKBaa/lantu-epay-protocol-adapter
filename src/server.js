import crypto from "node:crypto";
import express from "express";
import "dotenv/config";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const config = {
  port: numberEnv("PORT", 18080),
  publicBaseUrl: requiredEnv("PUBLIC_BASE_URL").replace(/\/$/, ""),
  lantuApiBase: env("LANTU_API_BASE", "https://api.ltzf.cn").replace(/\/$/, ""),
  lantuKey: requiredEnv("LANTU_KEY"),
};

const HTTP_TIMEOUT_MS = 15000;

const orders = new Map();

app.all("/submit.php", async (req, res) => {
  try {
    const input = collectParams(req);
    assertRequired(input, ["pid", "type", "out_trade_no", "notify_url", "return_url", "name", "money", "sign"]);

    if (!verifyEpaySign(input)) {
      return sendEpayError(res, "sign error");
    }

    const channel = mapChannel(input.type);
    const lantuPayload = buildLantuCreatePayload(input, channel);
    const lantuResp = await postForm(`${config.lantuApiBase}${channel.path}`, lantuPayload);

    if (lantuResp.code !== 0) {
      return sendEpayError(res, lantuResp.msg || "lantu create order failed");
    }

    const payment = extractPaymentUrls(lantuResp.data);
    const statusToken = crypto.randomBytes(16).toString("hex");
    const order = {
      outTradeNo: input.out_trade_no,
      pid: input.pid,
      tradeNo: "",
      type: input.type,
      name: input.name,
      money: input.money,
      notifyUrl: input.notify_url,
      returnUrl: input.return_url,
      statusToken,
      status: 0,
      createdAt: new Date().toISOString(),
      payment,
      lantu: lantuResp,
    };
    orders.set(input.out_trade_no, order);

    if (!payment.imageUrl && !payment.payUrl) {
      return res.json({ code: 1, msg: "lantu response missing pay url", raw: lantuResp });
    }

    const checkoutUrl = `${config.publicBaseUrl}/checkout?out_trade_no=${encodeURIComponent(input.out_trade_no)}&token=${statusToken}`;
    if (wantsJson(req)) {
      return res.json({ code: 1, msg: "success", trade_no: input.out_trade_no, payurl: checkoutUrl, qrcode: payment.imageUrl || payment.payUrl, url: checkoutUrl });
    }

    return res.type("html").send(renderCheckoutPage(order));
  } catch (error) {
    return sendEpayError(res, error.message);
  }
});

app.get("/checkout", (req, res) => {
  const input = collectParams(req);
  const order = input.out_trade_no ? orders.get(input.out_trade_no) : undefined;
  if (!order || input.token !== order.statusToken) {
    return res.status(404).type("text/plain").send("order not found");
  }

  return res.type("html").send(renderCheckoutPage(order));
});

app.get("/checkout/status", (req, res) => {
  const input = collectParams(req);
  const order = input.out_trade_no ? orders.get(input.out_trade_no) : undefined;
  if (!order || input.token !== order.statusToken) {
    return res.status(404).json({ code: -1, msg: "order not found" });
  }

  const paid = order.status === 1;
  return res.json({
    code: 1,
    paid,
    status: order.status,
    out_trade_no: order.outTradeNo,
    redirect_url: paid ? buildReturnUrl(order) : "",
  });
});

app.post("/lantu/notify", async (req, res) => {
  const input = collectParams(req);
  try {
    assertRequired(input, ["code", "timestamp", "mch_id", "order_no", "out_trade_no", "pay_no", "total_fee", "sign"]);
    if (!verifyLantuSign(input)) {
      return res.status(400).type("text/plain").send("FAIL");
    }

    const order = orders.get(input.out_trade_no) || decodeAttach(input.attach) || {};
    const notifyUrl = order.notifyUrl;
    if (!notifyUrl) {
      return res.status(400).type("text/plain").send("FAIL");
    }

    const paid = input.code === "0";
    const epayNotify = buildEpayNotify(input, order, paid);
    const downstream = await postForm(notifyUrl, epayNotify, false);
    if (String(downstream).trim().toLowerCase() !== "success") {
      return res.status(502).type("text/plain").send("FAIL");
    }

    orders.set(input.out_trade_no, {
      ...order,
      outTradeNo: input.out_trade_no,
      pid: order.pid || input.mch_id,
      tradeNo: input.order_no,
      status: paid ? 1 : 0,
      paidAt: input.success_time || new Date().toISOString(),
      lantuNotify: input,
    });

    return res.type("text/plain").send("SUCCESS");
  } catch (_error) {
    return res.status(400).type("text/plain").send("FAIL");
  }
});

app.get("/return", (req, res) => {
  const input = collectParams(req);
  const order = input.out_trade_no ? orders.get(input.out_trade_no) : undefined;
  if (!order?.returnUrl) {
    return res.type("text/plain").send("success");
  }

  const payload = buildEpayNotify(input, order, order.status === 1);
  const redirectUrl = appendQuery(order.returnUrl, payload);
  return res.redirect(302, redirectUrl);
});

app.all("/api.php", (req, res) => {
  const input = collectParams(req);
  if (input.act !== "order") {
    return res.json({ code: -1, msg: "unsupported act" });
  }
  if (!verifyEpaySign(input)) {
    return res.json({ code: -1, msg: "sign error" });
  }

  const outTradeNo = input.out_trade_no || input.trade_no;
  const order = outTradeNo ? orders.get(outTradeNo) : undefined;
  if (!order) {
    return res.json({ code: -1, msg: "order not found" });
  }

  return res.json({
    code: 1,
    msg: "success",
    trade_no: order.tradeNo || order.outTradeNo,
    out_trade_no: order.outTradeNo,
    type: order.type,
    name: order.name,
    money: order.money,
    status: order.status,
  });
});

app.listen(config.port, () => {
  console.log(`lantu-epay-adapter listening on :${config.port}`);
});

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

function collectParams(req) {
  return Object.fromEntries(
    Object.entries({ ...req.query, ...req.body })
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, Array.isArray(value) ? String(value[0]) : String(value)]),
  );
}

function assertRequired(params, names) {
  const missing = names.filter((name) => !params[name]);
  if (missing.length > 0) {
    throw new Error(`missing required params: ${missing.join(",")}`);
  }
}

function sign(params, key, exclude = ["sign", "sign_type"]) {
  const source = Object.entries(params)
    .filter(([name, value]) => !exclude.includes(name) && value !== undefined && value !== null && String(value) !== "")
    .sort(([a], [b]) => asciiCompare(a, b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return crypto.createHash("md5").update(`${source}${key ? `&key=${key}` : ""}`, "utf8").digest("hex").toUpperCase();
}

function epaySign(params) {
  const source = Object.entries(params)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type" && value !== undefined && value !== null && String(value) !== "")
    .sort(([a], [b]) => asciiCompare(a, b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return crypto.createHash("md5").update(`${source}${config.lantuKey}`, "utf8").digest("hex").toLowerCase();
}

function verifyEpaySign(params) {
  return timingSafeEqual(String(params.sign || "").toLowerCase(), epaySign(params));
}

function verifyLantuSign(params) {
  const signed = pick(params, ["code", "timestamp", "mch_id", "order_no", "out_trade_no", "pay_no", "total_fee"]);
  return timingSafeEqual(String(params.sign || "").toUpperCase(), sign(signed, config.lantuKey));
}

function asciiCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function pick(params, names) {
  return Object.fromEntries(names.filter((name) => params[name]).map((name) => [name, params[name]]));
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function mapChannel(type) {
  if (type === "wxpay") {
    return { payChannel: "wxpay", path: "/api/wxpay/native" };
  }
  if (type === "alipay") {
    return { payChannel: "alipay", path: "/api/alipay/native" };
  }
  throw new Error(`unsupported pay type: ${type}`);
}

function buildLantuCreatePayload(input, channel) {
  const payload = {
    mch_id: input.pid,
    out_trade_no: input.out_trade_no,
    total_fee: input.money,
    body: input.name,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    notify_url: `${config.publicBaseUrl}/lantu/notify`,
    return_url: input.return_url || `${config.publicBaseUrl}/return`,
    attach: encodeAttach({ pid: input.pid, notifyUrl: input.notify_url, returnUrl: input.return_url, type: input.type, name: input.name, money: input.money }),
  };

  payload.sign = sign(pick(payload, ["mch_id", "out_trade_no", "total_fee", "body", "timestamp", "notify_url"]), config.lantuKey);
  return payload;
}

function buildEpayNotify(input, order, paid) {
  const payload = {
    pid: order.pid || input.mch_id,
    trade_no: input.order_no || order.tradeNo || order.outTradeNo || input.out_trade_no,
    out_trade_no: input.out_trade_no || order.outTradeNo,
    type: order.type || lantuChannelToEpay(input.pay_channel),
    name: order.name || "payment",
    money: input.total_fee || order.money,
    trade_status: paid ? "TRADE_SUCCESS" : "TRADE_FAILED",
  };
  payload.sign = epaySign(payload);
  payload.sign_type = "MD5";
  return payload;
}

function lantuChannelToEpay(channel) {
  if (channel === "alipay") return "alipay";
  return "wxpay";
}

async function postForm(url, params, expectJson = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`http ${response.status}: ${text}`);
    }
    return expectJson ? JSON.parse(text) : text;
  } finally {
    clearTimeout(timer);
  }
}

function extractPaymentUrls(data) {
  if (typeof data === "string") return { payUrl: data, imageUrl: data };
  if (!data || typeof data !== "object") return { payUrl: "", imageUrl: "" };
  return {
    payUrl: data.payurl || data.url || data.code_url || data.QRcode_url || "",
    imageUrl: data.QRcode_url || data.qrcode || data.qr_code || data.payurl || data.url || "",
  };
}

function encodeAttach(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeAttach(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (_error) {
    return undefined;
  }
}

function appendQuery(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

function wantsJson(req) {
  return req.query.format === "json" || req.body.format === "json" || req.get("accept")?.includes("application/json");
}

function sendEpayError(res, msg) {
  return res.status(400).json({ code: -1, msg });
}

function buildReturnUrl(order) {
  if (!order.returnUrl) return "";
  const payload = buildEpayNotify({ order_no: order.tradeNo, out_trade_no: order.outTradeNo, total_fee: order.money }, order, order.status === 1);
  return appendQuery(order.returnUrl, payload);
}

function renderCheckoutPage(order) {
  const statusUrl = `${config.publicBaseUrl}/checkout/status?out_trade_no=${encodeURIComponent(order.outTradeNo)}&token=${order.statusToken}`;
  const imageUrl = order.payment.imageUrl || order.payment.payUrl;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>支付收银台</title>
  <style>
    body{margin:0;background:#f6f7fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:min(420px,100%);background:#fff;border-radius:18px;box-shadow:0 18px 60px rgba(15,23,42,.12);padding:28px;text-align:center}.title{font-size:22px;font-weight:700;margin:0 0 8px}.sub{color:#64748b;margin:0 0 22px}.qr{width:240px;height:240px;object-fit:contain;border:1px solid #e5e7eb;border-radius:14px;padding:12px;background:#fff}.meta{margin:20px 0;text-align:left;background:#f8fafc;border-radius:12px;padding:14px 16px;color:#334155;font-size:14px}.row{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.row span:first-child{color:#64748b}.status{margin-top:16px;color:#2563eb;font-weight:600}.hint{margin-top:14px;color:#94a3b8;font-size:13px}
  </style>
</head>
<body>
  <div class="wrap"><main class="card">
    <h1 class="title">请扫码完成支付</h1>
    <p class="sub">支付成功后页面会自动跳转</p>
    ${imageUrl ? `<img class="qr" src="${escapeHtml(imageUrl)}" alt="支付二维码">` : ""}
    <div class="meta">
      <div class="row"><span>商品</span><strong>${escapeHtml(order.name)}</strong></div>
      <div class="row"><span>金额</span><strong>${escapeHtml(order.money)} 元</strong></div>
      <div class="row"><span>订单号</span><strong>${escapeHtml(order.outTradeNo)}</strong></div>
    </div>
    <div id="status" class="status">等待支付结果...</div>
    <div class="hint">请不要关闭此页面</div>
  </main></div>
  <script>
    const statusEl = document.getElementById('status');
    async function poll(){
      try{
        const res = await fetch(${JSON.stringify(statusUrl)}, { cache: 'no-store' });
        const data = await res.json();
        if(data.paid){
          statusEl.textContent = '支付成功，正在返回...';
          if(data.redirect_url){ location.replace(data.redirect_url); }
          return;
        }
      }catch(e){}
      setTimeout(poll, 2000);
    }
    poll();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
