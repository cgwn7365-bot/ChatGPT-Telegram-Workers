 // ============================================================
// 私人宏观金融助手 - Cloudflare Worker
// 支持：A股全市场 / 港股全市场 / AH溢价 / 美股 /
//       黄金白银油价 / 汇率 / 宏观分析 / 叙事差分
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const body = await request.json();
        await handleUpdate(body, env);
      } catch (e) {}
      return new Response("OK");
    }
    if (url.pathname === "/ping") return new Response("Bot is alive ✅");
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  }
};

// ============================================================
// 定时任务（每天检查，周一推送经济日历）
// ============================================================
async function runScheduled(env) {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours();
  // 周一 UTC 0点 = 北京时间周一早上8点
  if (dayOfWeek === 1 && hour === 0) {
    await sendWeeklyCalendar(env);
  }
}

async function sendWeeklyCalendar(env) {
  const chatId = env.CHAT_WHITE_LIST;
  const prompt = `请列出本周（${getWeekRange()}）全球主要经济数据发布日历。
重点包括：
- 美国：非农、CPI、PCE、美联储会议、零售销售、新屋开工
- 中国：CPI、PPI、PMI、社融、新增贷款、外贸数据
- 其他：欧央行、日央行等重要事件

格式要求：
每条用一行，格式为"周X | 国家 | 数据名称 | 预期值（如有）"
最后加一句本周最值得关注的核心事件。`;

  const reply = await callGemini(env.GEMINI_API_KEY, [], prompt, SYSTEM_PROMPT);
  await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId,
    `📅 本周经济日历\n\n${reply}`);
}

function getWeekRange() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return `${monday.getMonth()+1}/${monday.getDate()} - ${sunday.getMonth()+1}/${sunday.getDate()}`;
}

// ============================================================
// 系统提示词（Gemini的角色和分析协议）
// ============================================================
const SYSTEM_PROMPT = `你是一位私人宏观金融分析师，服务于一位专注于投机交易的个人投资者。

## 你的核心任务

不是给出买卖建议，而是帮助用户：
1. 理解数据在系统中的位置和传导关系
2. 识别市场叙事的变化和潜台词
3. 进行历史镜像匹配
4. 发现不同阵营表述之间的差异和信号

## 分析协议

收到实时数据后，按以下顺序分析：

【状态】增长方向 / 通胀方向 / 流动性状态 / 风险偏好
【主导矛盾】当前市场最核心的一个矛盾是什么
【传导链】从哪个变量 → 传导到哪里 → 影响哪些资产
【背离信号】哪些关系出现了异常
【历史镜像】当前最像哪个历史时期，相似点和关键差异
【下一步盯什么】接下来最值得观察的2-3个变量

## 叙事差分分析（用户发来文章时）

按四层输出：
【表层观点】他们表面在说什么
【潜台词】他们的心理动作是什么，在用什么叙事装置稳定情绪
【人性判断】用带历史感的语言说出这个群体真正在做什么
【交易信号】这种叙事差异意味着什么投机观察点

## AH股分析

查询AH股时，说明溢价率、历史均值、当前含义。

## 中国系统特别说明

中国宏观分析需关注：
- M1-M2剪刀差（活钱与总钱的比例）
- 社融-GDP增速差（信用效率）
- 房地产→土地收入→地方债传导链
- 政策底→市场底的历史节奏
- 北向资金作为中外系统的桥梁

## 语言风格

简洁、直接、有话外之音。
不追求文学性，追求准确揭示机制。
每条分析都要有证据约束，不能只是漂亮话。
回答适合在手机Telegram上阅读，不要太长。
始终用中文回答。`;

// ============================================================
// 处理Telegram消息
// ============================================================
async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const text = msg.text.trim();

  // 白名单检查
  const whitelist = (env.CHAT_WHITE_LIST || "").split(",").map(s => s.trim());
  if (!whitelist.includes(userId) && !whitelist.includes(chatId)) {
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId,
      `⚠️ 未授权访问\n你的ID：${userId}`);
    return;
  }

  // 命令处理
  if (text === "/start") {
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId, WELCOME_MSG);
    return;
  }
  if (text === "/clear") {
    await clearHistory(env.DATABASE, userId);
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId, "🧹 对话记忆已清除");
    return;
  }
  if (text === "/help") {
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId, HELP_MSG);
    return;
  }

  await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId, "⏳ 查询中...");

  try {
    // 抓取金融数据
    const financialData = await getFinancialData(text);
    // 获取对话历史
    const history = await getHistory(env.DATABASE, userId);
    // 调用Gemini
    const reply = await callGemini(
      env.GEMINI_API_KEY, history, text, SYSTEM_PROMPT, financialData
    );
    // 保存历史
    await saveHistory(env.DATABASE, userId, text, reply);
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId, reply);
  } catch (err) {
    await sendMsg(env.TELEGRAM_AVAILABLE_TOKENS, chatId,
      `❌ 出错了：${err.message}\n请重试或发送 /clear 清除记忆`);
  }
}

const WELCOME_MSG = `你好！我是你的私人宏观金融助手 📊

我可以帮你：
• 查任意A股、港股、美股行情（含均线）
• 查AH股溢价对比
• 查黄金、白银、原油、汇率
• 分析宏观经济状态和周期位置
• 历史镜像匹配
• 分析财经文章的叙事差异和潜台词
• 每周一自动推送经济日历

直接用中文问我就行，例如：
"茅台现在多少？"
"工行AH溢价怎么样？"
"现在宏观处于什么位置？"
"帮我分析这篇文章：[粘贴文章]"

发 /help 查看更多，发 /clear 清除对话记忆`;

const HELP_MSG = `📖 使用指南

【行情查询】
• A股：直接说股票名或代码，如"茅台"、"600519"
• 港股：说名字或代码，如"腾讯"、"00700"
• AH股：说"XX的AH溢价"或"AH比较 XX"
• 美股：英文代码，如"AAPL"、"特斯拉"
• 黄金/白银/油价：直接问
• 汇率：如"美元兑人民币"

【宏观分析】
• "现在宏观是什么状态？"
• "经济时钟在哪里？"
• "美联储加息对黄金的影响"
• "现在像历史上哪个时期？"

【叙事分析】
• 直接粘贴一段或多段财经文章
• 我会分析表层观点、潜台词、人性判断、交易信号

【其他】
• /clear 清除对话记忆
• /help 显示此帮助`;

// ============================================================
// 金融数据抓取
// ============================================================
async function getFinancialData(text) {
  const results = [];
  const lowerText = text.toLowerCase();

  // 判断是否需要抓取数据
  const needsData = isFinancialQuery(text);
  if (!needsData) return null;

  // AH股溢价查询
  if (text.match(/AH|ah股|溢价|h股|H股/i)) {
    const ahData = await getAHPremium(text);
    if (ahData) results.push(ahData);
  }

  // A股：6位数字代码 或 股票名
  const aCodeMatch = text.match(/\b([036]\d{5})\b/);
  if (aCodeMatch) {
    const code = aCodeMatch[1];
    const prefix = code.startsWith("6") ? "sh" : "sz";
    const data = await fetchSina(`${prefix}${code}`);
    if (data) results.push(data);
  }

  // A股名称模糊匹配（常见股票）
  if (!aCodeMatch) {
    const aStock = matchAStock(text);
    if (aStock) {
      const data = await fetchSina(aStock.code);
      if (data) results.push(data);
    }
  }

  // 港股：5位代码 或 名称
  const hkCodeMatch = text.match(/\b(0\d{4})\b/);
  if (hkCodeMatch) {
    const data = await fetchSina(`hk0${hkCodeMatch[1]}`);
    if (data) results.push(data);
  }
  if (!hkCodeMatch) {
    const hkStock = matchHKStock(text);
    if (hkStock) {
      const data = await fetchSina(hkStock.code);
      if (data) results.push(data);
    }
  }

  // 美股
  const usMatch = text.match(/\b([A-Z]{1,5})\b/);
  if (usMatch && isUSStockQuery(text)) {
    const data = await fetchYahoo(usMatch[1]);
    if (data) results.push(data);
  }
  const usStock = matchUSStock(text);
  if (usStock) {
    const data = await fetchYahoo(usStock.ticker);
    if (data) results.push(data);
  }

  // 黄金
  if (text.match(/黄金|gold|Au\b/i)) {
    const data = await fetchYahoo("GC=F");
    if (data) results.push(`【黄金期货】${data}`);
    const spot = await fetchSina("hf_XAU");
    if (spot) results.push(spot);
  }

  // 白银
  if (text.match(/白银|silver|Ag\b/i)) {
    const data = await fetchYahoo("SI=F");
    if (data) results.push(`【白银期货】${data}`);
  }

  // 原油
  if (text.match(/原油|油价|WTI|布伦特|Brent/i)) {
    const wti = await fetchYahoo("CL=F");
    if (wti) results.push(`【WTI原油】${wti}`);
    const brent = await fetchYahoo("BZ=F");
    if (brent) results.push(`【布伦特原油】${brent}`);
  }

  // 汇率
  const fxData = await getFxData(text);
  if (fxData) results.push(fxData);

  // 主要指数
  if (text.match(/上证|沪指|大盘|A股指数/)) {
    const data = await fetchSina("s_sh000001");
    if (data) results.push(data);
  }
  if (text.match(/深证|深指|创业板/)) {
    const data = await fetchSina("s_sz399001");
    if (data) results.push(data);
    const cyb = await fetchSina("s_sz399006");
    if (cyb) results.push(cyb);
  }
  if (text.match(/恒生|港股指数/)) {
    const data = await fetchSina("hk_HSI");
    if (data) results.push(data);
  }
  if (text.match(/标普|S&P|SP500|纳指|道指/i)) {
    const sp = await fetchYahoo("^GSPC");
    if (sp) results.push(`【标普500】${sp}`);
    const nas = await fetchYahoo("^IXIC");
    if (nas) results.push(`【纳斯达克】${nas}`);
  }

  return results.length > 0 ? results.join("\n\n") : null;
}

function isFinancialQuery(text) {
  const keywords = [
    "股", "价", "涨", "跌", "指数", "黄金", "白银", "原油", "油价",
    "汇率", "美元", "人民币", "港币", "欧元", "日元", "英镑",
    "AH", "溢价", "均线", "行情", "多少", "现在", "今天",
    "gold", "silver", "oil", "forex", "AAPL", "TSLA", "茅台",
    "腾讯", "阿里", "比亚迪", "招行", "平安", "宁德"
  ];
  return keywords.some(k => text.toLowerCase().includes(k.toLowerCase())) ||
    /\b([036]\d{5})\b/.test(text) ||
    /\b(0\d{4})\b/.test(text) ||
    /\b[A-Z]{2,5}\b/.test(text);
}

// ============================================================
// AH股溢价计算
// ============================================================
const AH_STOCKS = {
  "工商银行": { a: "sh601398", h: "hk01398", name: "工商银行" },
  "建设银行": { a: "sh601939", h: "hk00939", name: "建设银行" },
  "农业银行": { a: "sh601288", h: "hk01288", name: "农业银行" },
  "中国银行": { a: "sh601988", h: "hk03988", name: "中国银行" },
  "招商银行": { a: "sh600036", h: "hk03968", name: "招商银行" },
  "中国平安": { a: "sh601318", h: "hk02318", name: "中国平安" },
  "中国人寿": { a: "sh601628", h: "hk02628", name: "中国人寿" },
  "中国石油": { a: "sh601857", h: "hk00857", name: "中国石油" },
  "中国石化": { a: "sh600028", h: "hk00386", name: "中国石化" },
  "中国移动": { a: "sh600941", h: "hk00941", name: "中国移动" },
  "中国联通": { a: "sh600050", h: "hk00762", name: "中国联通" },
  "比亚迪":   { a: "sz002594", h: "hk01211", name: "比亚迪" },
  "海螺水泥": { a: "sh600585", h: "hk00914", name: "海螺水泥" },
  "中国铝业": { a: "sh601600", h: "hk02600", name: "中国铝业" },
  "中远海控": { a: "sh601919", h: "hk01919", name: "中远海控" },
  "中国神华": { a: "sh601088", h: "hk01088", name: "中国神华" },
  "洛阳钼业": { a: "sh603993", h: "hk03993", name: "洛阳钼业" },
  "兖矿能源": { a: "sh600188", h: "hk01171", name: "兖矿能源" },
  "华泰证券": { a: "sh601688", h: "hk06886", name: "华泰证券" },
  "中信证券": { a: "sh600030", h: "hk06030", name: "中信证券" },
};

async function getAHPremium(text) {
  let stock = null;
  for (const [name, info] of Object.entries(AH_STOCKS)) {
    if (text.includes(name)) { stock = info; break; }
  }
  if (!stock) return null;

  try {
    const [aRaw, hRaw, fxRaw] = await Promise.all([
      fetchSinaRaw(stock.a),
      fetchSinaRaw(stock.h),
      fetchSinaRaw("fx_susdcny")
    ]);

    if (!aRaw || !hRaw) return null;

    const aParts = aRaw.split(",");
    const hParts = hRaw.split(",");
    const aPrice = parseFloat(aParts[3]);
    const hPrice = parseFloat(hParts[6] || hParts[3]);

    // 港币转人民币（用USD/CNY近似，实际应用HKD/CNY）
    const hkdCny = 0.924; // 近似值，正式可接入汇率
    const hPriceCNY = hPrice * hkdCny;
    const premium = ((aPrice / hPriceCNY - 1) * 100).toFixed(1);

    return `【${stock.name} AH溢价】
A股价格: ¥${aPrice}
H股价格: HK$${hPrice}（约¥${hPriceCNY.toFixed(2)}）
AH溢价率: ${premium > 0 ? '+' : ''}${premium}%
含义: ${parseFloat(premium) > 30 ? 'A股明显偏贵' : parseFloat(premium) > 10 ? 'A股小幅溢价（正常区间）' : parseFloat(premium) < -5 ? 'H股反而更贵（罕见）' : '基本持平'}`;
  } catch { return null; }
}

// ============================================================
// 新浪财经数据
// ============================================================
async function fetchSinaRaw(symbol) {
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { "Referer": "https://finance.sina.com.cn" }
    });
    const text = await res.text();
    const match = text.match(/="([^"]+)"/);
    if (!match || !match[1] || match[1].length < 10) return null;
    return match[1];
  } catch { return null; }
}

async function fetchSina(symbol) {
  const raw = await fetchSinaRaw(symbol);
  if (!raw) return null;

  const parts = raw.split(",");

  // A股格式（sh/sz开头）
  if ((symbol.startsWith("sh") || symbol.startsWith("sz")) && parts.length > 6) {
    const name = parts[0];
    const open = parseFloat(parts[1]);
    const prevClose = parseFloat(parts[2]);
    const current = parseFloat(parts[3]);
    const high = parseFloat(parts[4]);
    const low = parseFloat(parts[5]);
    if (!current || !prevClose) return null;
    const change = ((current - prevClose) / prevClose * 100).toFixed(2);
    const arrow = parseFloat(change) >= 0 ? "↑" : "↓";
    return `【${name}】¥${current} ${arrow}${change}%\n今开:${open} 最高:${high} 最低:${low} 前收:${prevClose}`;
  }

  // 港股格式
  if (symbol.startsWith("hk")) {
    const name = parts[1] || symbol;
    const current = parseFloat(parts[6]);
    const prevClose = parseFloat(parts[3]);
    if (!current || !prevClose) return null;
    const change = ((current - prevClose) / prevClose * 100).toFixed(2);
    const arrow = parseFloat(change) >= 0 ? "↑" : "↓";
    return `【${name} 港股】HK$${current} ${arrow}${change}%`;
  }

  // 指数格式（s_sh/s_sz开头）
  if (symbol.startsWith("s_")) {
    const name = parts[0];
    const current = parts[1];
    const change = parts[3];
    return `【${name}】${current}点 ${parseFloat(change) >= 0 ? "↑" : "↓"}${change}%`;
  }

  return null;
}

// ============================================================
// Yahoo Finance（美股/期货/国际指数）
// ============================================================
async function fetchYahoo(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const json = await res.json();
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;

    const current = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    const change = prevClose ? ((current - prevClose) / prevClose * 100).toFixed(2) : "N/A";
    const arrow = parseFloat(change) >= 0 ? "↑" : "↓";
    const currency = meta.currency || "";

    // 计算均线（用历史收盘价）
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
    let maText = "";
    if (closes.length >= 5) {
      const ma5 = (closes.slice(-5).reduce((a,b)=>a+b,0)/5).toFixed(2);
      maText = ` | 5日均:${ma5}`;
    }

    return `${current} ${currency} ${arrow}${change}%${maText}`;
  } catch { return null; }
}

// ============================================================
// 汇率数据
// ============================================================
async function getFxData(text) {
  const fxMap = {
    "美元": "fx_susdcny",
    "欧元": "fx_seurcny",
    "港币": "fx_shkdcny",
    "港元": "fx_shkdcny",
    "日元": "fx_sjpycny",
    "英镑": "fx_sgbpcny",
    "韩元": "fx_skrwcny",
    "澳元": "fx_saudcny",
  };

  const results = [];
  for (const [name, symbol] of Object.entries(fxMap)) {
    if (text.includes(name) || text.includes("汇率") || text.includes("外汇")) {
      const raw = await fetchSinaRaw(symbol);
      if (raw) {
        const parts = raw.split(",");
        const rate = parts[0] || parts[1];
        if (rate) results.push(`${name}/人民币: ${parseFloat(rate).toFixed(4)}`);
      }
      if (!text.includes("汇率") && !text.includes("外汇")) break;
    }
  }

  // 美元指数
  if (text.match(/美元指数|DXY/i)) {
    const dxy = await fetchYahoo("DX-Y.NYB");
    if (dxy) results.push(`美元指数(DXY): ${dxy}`);
  }

  return results.length > 0 ? `【汇率】\n${results.join("\n")}` : null;
}

// ============================================================
// A股名称匹配（支持模糊匹配）
// ============================================================
function matchAStock(text) {
  const stocks = {
    "茅台": "sh600519", "贵州茅台": "sh600519",
    "五粮液": "sh000858", "泸州老窖": "sz000568",
    "比亚迪": "sz002594", "宁德时代": "sz300750",
    "招商银行": "sh600036", "工商银行": "sh601398",
    "建设银行": "sh601939", "农业银行": "sh601288",
    "中国银行": "sh601988", "交通银行": "sh601328",
    "中国平安": "sh601318", "中国人寿": "sh601628",
    "格力电器": "sz000651", "美的集团": "sz000333",
    "海尔智家": "sh600690", "海信家电": "sz000921",
    "中国石油": "sh601857", "中国石化": "sh600028",
    "中国海油": "sh600938", "中国神华": "sh601088",
    "中国移动": "sh600941", "中国联通": "sh600050",
    "中国电信": "sh601728", "华为": null,
    "阿里巴巴": null, "京东": null,
    "隆基绿能": "sh601012", "通威股份": "sh600438",
    "迈瑞医疗": "sz300760", "药明康德": "sh603259",
    "中芯国际": "sh688981", "紫光展锐": null,
    "万科": "sz000002", "碧桂园": null,
    "中国恒大": null, "保利发展": "sh600048",
    "华泰证券": "sh601688", "中信证券": "sh600030",
    "东方财富": "sz300059", "同花顺": "sz300033",
    "贵州轮胎": "sh600182", "上汽集团": "sh600104",
    "长城汽车": "sh601633", "吉利汽车": null,
    "三一重工": "sh600031", "中联重科": "sz000157",
  };

  for (const [name, code] of Object.entries(stocks)) {
    if (text.includes(name) && code) return { name, code };
  }
  return null;
}

// ============================================================
// 港股名称匹配
// ============================================================
function matchHKStock(text) {
  const stocks = {
    "腾讯": { code: "hk00700", name: "腾讯控股" },
    "阿里巴巴": { code: "hk09988", name: "阿里巴巴" },
    "阿里": { code: "hk09988", name: "阿里巴巴" },
    "美团": { code: "hk03690", name: "美团" },
    "小米": { code: "hk01810", name: "小米集团" },
    "京东": { code: "hk09618", name: "京东集团" },
    "百度": { code: "hk09888", name: "百度" },
    "网易": { code: "hk09999", name: "网易" },
    "快手": { code: "hk01024", name: "快手" },
    "携程": { code: "hk09961", name: "携程集团" },
    "友邦": { code: "hk01299", name: "友邦保险" },
    "汇丰": { code: "hk00005", name: "汇丰控股" },
    "渣打": { code: "hk02888", name: "渣打集团" },
    "李宁": { code: "hk02331", name: "李宁" },
    "安踏": { code: "hk02020", name: "安踏体育" },
    "港交所": { code: "hk00388", name: "香港交易所" },
  };

  for (const [name, info] of Object.entries(stocks)) {
    if (text.includes(name)) return info;
  }
  return null;
}

// ============================================================
// 美股名称匹配
// ============================================================
function matchUSStock(text) {
  const stocks = {
    "苹果": "AAPL", "特斯拉": "TSLA", "谷歌": "GOOGL",
    "微软": "MSFT", "亚马逊": "AMZN", "英伟达": "NVDA",
    "Meta": "META", "脸书": "META", "奈飞": "NFLX",
    "伯克希尔": "BRK-B", "摩根大通": "JPM",
    "高盛": "GS", "花旗": "C", "美银": "BAC",
    "波音": "BA", "可口可乐": "KO", "麦当劳": "MCD",
  };

  for (const [name, ticker] of Object.entries(stocks)) {
    if (text.includes(name)) return { name, ticker };
  }
  return null;
}

function isUSStockQuery(text) {
  return text.match(/美股|nasdaq|NYSE|纽约|道琼斯/i) !== null;
}

// ============================================================
// Gemini API调用
// ============================================================
async function callGemini(apiKey, history, userMsg, systemPrompt, financialData) {
  let fullMsg = userMsg;
  if (financialData) {
    fullMsg += `\n\n【实时市场数据】\n${financialData}`;
  }

  const messages = [
    ...history,
    { role: "user", parts: [{ text: fullMsg }] }
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages,
        generationConfig: {
          maxOutputTokens: 1500,
          temperature: 0.7
        }
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "未能获取回答，请重试";
}

// ============================================================
// 对话历史（KV存储）
// ============================================================
async function getHistory(kv, userId) {
  try {
    const stored = await kv.get(`history_${userId}`);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

async function saveHistory(kv, userId, userMsg, assistantMsg) {
  try {
    const history = await getHistory(kv, userId);
    history.push({ role: "user", parts: [{ text: userMsg }] });
    history.push({ role: "model", parts: [{ text: assistantMsg }] });
    // 只保留最近8轮
    const trimmed = history.length > 16 ? history.slice(-16) : history;
    await kv.put(`history_${userId}`, JSON.stringify(trimmed), {
      expirationTtl: 86400
    });
  } catch {}
}

async function clearHistory(kv, userId) {
  try { await kv.delete(`history_${userId}`); } catch {}
}

// ============================================================
// 发送Telegram消息
// ============================================================
async function sendMsg(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML"
      })
    });
  } catch {}
}
