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
  lantuMchId: requiredEnv("LANTU_MCH_ID"),
  lantuKey: requiredEnv("LANTU_KEY"),
  wxpayMode: env("LANTU_WXPAY_MODE", "native"),
  alipayMode: env("LANTU_ALIPAY_MODE", "native"),
  developerAppid: env("LANTU_DEVELOPER_APPID", ""),
  httpTimeoutMs: numberEnv("HTTP_TIMEOUT_MS", 15000),
};

const orders = new Map();

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.all("/submit.php", async (req, res) => {
  try {
    const input = collectParams(req);
    assertRequired(input, ["pid", "type", "out_trade_no", "notify_url", "return_url", "name", "money", "sign"]);

    if (input.pid !== config.lantuMchId) {
      return sendEpayError(res, "pid error");
    }
    if (!verifyEpaySign(input)) {
      return sendEpayError(res, "sign error");
    }

    const channel = mapChannel(input.type);
    const lantuPayload = buildLantuCreatePayload(input, channel);
    const lantuResp = await postForm(`${config.lantuApiBase}${channel.path}`, lantuPayload);

    if (lantuResp.code !== 0) {
      return sendEpayError(res, lantuResp.msg || "lantu create order failed");
    }

    const payUrl = extractPayUrl(lantuResp.data);
    orders.set(input.out_trade_no, {
      outTradeNo: input.out_trade_no,
      tradeNo: "",
      type: input.type,
      name: input.name,
      money: input.money,
      notifyUrl: input.notify_url,
      returnUrl: input.return_url,
      status: 0,
      createdAt: new Date().toISOString(),
      lantu: lantuResp,
    });

    if (!payUrl) {
      return res.json({ code: 1, msg: "lantu response missing pay url", raw: lantuResp });
    }

    if (wantsJson(req)) {
      return res.json({ code: 1, msg: "success", trade_no: input.out_trade_no, payurl: payUrl, qrcode: payUrl, url: payUrl });
    }

    return res.type("html").send(renderRedirectPage(payUrl));
  } catch (error) {
    return sendEpayError(res, error.message);
  }
});

app.post("/lantu/notify", async (req, res) => {
  const input = collectParams(req);
  try {
    assertRequired(input, ["code", "timestamp", "mch_id", "order_no", "out_trade_no", "pay_no", "total_fee", "sign"]);
    if (input.mch_id !== config.lantuMchId) {
      return res.status(400).type("text/plain").send("FAIL");
    }
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
  if (input.pid !== config.lantuMchId || !verifyEpaySign(input)) {
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
    return { payChannel: "wxpay", tradeType: config.wxpayMode, path: `/api/wxpay/${config.wxpayMode}` };
  }
  if (type === "alipay") {
    return { payChannel: "alipay", tradeType: config.alipayMode, path: `/api/alipay/${config.alipayMode}` };
  }
  throw new Error(`unsupported pay type: ${type}`);
}

function buildLantuCreatePayload(input, channel) {
  const payload = {
    mch_id: config.lantuMchId,
    out_trade_no: input.out_trade_no,
    total_fee: input.money,
    body: input.name,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    notify_url: `${config.publicBaseUrl}/lantu/notify`,
    return_url: input.return_url || `${config.publicBaseUrl}/return`,
    attach: encodeAttach({ notifyUrl: input.notify_url, returnUrl: input.return_url, type: input.type, name: input.name, money: input.money }),
  };

  if (config.developerAppid) {
    payload.developer_appid = config.developerAppid;
  }
  if (channel.payChannel === "wxpay" && channel.tradeType === "jump_h5" && input.return_url) {
    payload.quit_url = input.return_url;
  }

  payload.sign = sign(pick(payload, ["mch_id", "out_trade_no", "total_fee", "body", "timestamp", "notify_url"]), config.lantuKey);
  return payload;
}

function buildEpayNotify(input, order, paid) {
  const payload = {
    pid: config.lantuMchId,
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
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
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

function extractPayUrl(data) {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  return data.payurl || data.url || data.QRcode_url || data.code_url || "";
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

function renderRedirectPage(payUrl) {
  const safeUrl = escapeHtml(payUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting</title></head><body><p>Redirecting to payment...</p><script>location.replace(${JSON.stringify(payUrl)});</script><a href="${safeUrl}">Continue</a></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
