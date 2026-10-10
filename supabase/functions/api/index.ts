// つきのしらせ API (Supabase Edge Function)
// All data access goes through here with the service role; tables have RLS on and no policies.
// Auth: each device holds a random token; only its SHA-256 hash is stored.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// only the app's own pages may call this API from a browser
const ALLOWED_ORIGIN = "https://growthpath-jp.github.io";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tsuki-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/* ---------------- secrets & push ---------------- */
let secrets: Record<string, string> | null = null;
async function getSecrets() {
  if (secrets) return secrets;
  const { data, error } = await sb.from("app_secrets").select("key,value");
  if (error) throw error;
  secrets = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  webpush.setVapidDetails(secrets.vapid_subject, secrets.vapid_public, secrets.vapid_private);
  return secrets;
}

type Target = "owner" | "partner" | "all" | { member: string };
async function pushTo(pairId: string, target: Target, title: string, body: string, kind: string, url = "./") {
  await getSecrets();
  const shown = { title, body };
  const { data: pr } = await sb.from("pairs").select("settings").eq("id", pairId).maybeSingle();
  if (pr?.settings?.discreetPush) { shown.title = "お知らせ"; shown.body = "新しいメッセージがあります。"; }
  let q = sb.from("members").select("id,role").eq("pair_id", pairId);
  if (target === "owner" || target === "partner") q = q.eq("role", target).eq("status", "active");
  if (typeof target === "object") q = q.eq("id", target.member);
  const { data: mems, error } = await q;
  if (error) throw error;
  const ids = (mems ?? []).map((m) => m.id);
  let delivered = 0, failed = 0, recipients = ids.length;
  const errors: string[] = [];
  if (ids.length) {
    const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth").in("member_id", ids);
    const payload = JSON.stringify({ title: shown.title, body: shown.body, url, tag: kind + "-" + Date.now() });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 60 * 60 * 24, urgency: "high",
        });
        delivered++;
      } catch (e) {
        failed++;
        const sc = (e as { statusCode?: number }).statusCode;
        errors.push(String(sc ?? (e as Error).message));
        if (sc === 404 || sc === 410) await sb.from("push_subs").delete().eq("id", s.id); // expired
      }
    }
  }
  const label = typeof target === "object" ? "self" : target;
  await sb.from("notices").insert({ pair_id: pairId, kind, target: label, title, body, delivered, failed });
  if (errors.length) console.warn("push errors", errors.join(","));
  return { recipients, delivered, failed };
}

/* ---------------- dates & stats ---------------- */
// add さん unless the name already ends with an honorific (まりちゃん, あっくん …)
const hon = (n: string) => (/(さん|ちゃん|くん|君|様|さま|たん|氏|ちん)$/.test(n) ? n : n + "さん");
const pad = (n: number) => String(n).padStart(2, "0");
const isDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= "2000-01-01";
};
// fixed choices of the 体調記録 (must match the app)
const FLOWS = ["なし", "少ない", "普通", "多い"];
const SYMS = ["腹痛", "腰痛", "頭痛", "胸の張り", "むくみ", "肌荒れ", "眠気", "だるさ", "吐き気", "食欲増加", "イライラ", "不眠"];
const MOODS = ["良い", "普通", "イライラ", "もやもや", "落ち込み", "悲しい", "不安"];
const cleanWords = (v: unknown, max: number, len: number) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string").map((x) => (x as string).trim().slice(0, len)).filter(Boolean))].slice(0, max) : [];
// one 体調記録 row, validated the same way for day_save and import
function dayRow(pairId: string, d: Record<string, unknown>) {
  const moods = typeof d.mood === "string" ? d.mood.split("・").filter((m) => MOODS.includes(m)) : [];
  return {
    pair_id: pairId, date: d.date as string,
    flow: typeof d.flow === "string" && FLOWS.includes(d.flow) ? d.flow : null,
    symptoms: cleanWords(d.symptoms, 20, 20).filter((x) => SYMS.includes(x)),
    mood: moods.length ? [...new Set(moods)].join("・") : null,
    others: cleanWords(d.others, 30, 30),
    memo: typeof d.memo === "string" ? d.memo.slice(0, 1000) : "",
    updated_at: new Date().toISOString(),
  };
}
const MAX_DAYS = 4000, MAX_PERIODS = 600;
const utc = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const toStr = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (s: string, n: number) => toStr(utc(s) + n * 864e5);
const diff = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 864e5); // b - a
const todayJST = () => toStr(Date.now() + 9 * 3600e3);
const DOW = "日月火水木金土";
const fmt = (s: string) => { const d = new Date(utc(s)); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${DOW[d.getUTCDay()]})`; };

const DEFAULT_SETTINGS = {
  defCycle: 28, defLen: 5,
  notifyPartnerStart: true, notifyPartnerEnd: false,
  remindSelf3: true, remindSelfDay: true, remindPartner3: false, sharePrediction: false, discreetPush: false,
  pmsNotify: true, pmsDays: 10,
  showOvuList: true, showPmsList: true, // lines in 「今後の生理予定日」 on the recorder's home
  shareDays: false, shareMemo: false, // show the 体調記録 to the partner (memo separately)
  otherWords: [] as string[], // the recorder's own words for 体調記録「その他」
};
type Period = { id: string; start_date: string; end_date: string | null; shared?: boolean };

function computeStats(periods: Period[], settings: typeof DEFAULT_SETTINGS, today: string) {
  const ps = [...periods].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const cycles: number[] = [];
  for (let i = 1; i < ps.length; i++) {
    const c = diff(ps[i - 1].start_date, ps[i].start_date);
    if (c >= 15 && c <= 60) cycles.push(c);
  }
  const rc = cycles.slice(-6);
  const avgCycle = rc.length ? Math.round(rc.reduce((a, b) => a + b, 0) / rc.length) : Number(settings.defCycle) || 28;
  const lens = ps.filter((p) => p.end_date).map((p) => diff(p.start_date, p.end_date!) + 1).filter((n) => n >= 1 && n <= 14).slice(-6);
  const avgLen = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : Number(settings.defLen) || 5;
  const last = ps.at(-1) ?? null;
  const active = last && !last.end_date && diff(last.start_date, today) >= 0 && diff(last.start_date, today) < 14 ? last : null;
  const predictions: { start: string; end: string; ovulation: string; fertileStart: string; fertileEnd: string }[] = [];
  if (last) {
    // at least 4 cycles AND at least ~3.5 months ahead of today
    for (let k = 1; k <= 24; k++) {
      const s = addDays(last.start_date, avgCycle * k);
      const ov = addDays(s, -14);
      predictions.push({ start: s, end: addDays(s, avgLen - 1), ovulation: ov, fertileStart: addDays(ov, -5), fertileEnd: addDays(ov, 1) });
      if (k >= 4 && diff(today, s) > 105) break;
    }
  }
  return {
    avgCycle, avgLen, cycleSource: rc.length ? "record" : "default", lenSource: lens.length ? "record" : "default",
    cycles, lastStart: last?.start_date ?? null, activeId: active?.id ?? null,
    next: predictions[0]?.start ?? null, predictions,
  };
}

/* ---------------- auth ---------------- */
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const safeEqual = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const randToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const randCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b).map((x) => A[x % A.length]).join("");
};
type Member = { id: string; pair_id: string; role: "owner" | "partner"; name: string; status: "pending" | "active" };
async function auth(req: Request): Promise<Member> {
  const t = req.headers.get("x-tsuki-token");
  if (!t || t.length < 20) throw new ApiError("unauthorized", "この端末は登録されていません。", 401);
  const { data } = await sb.from("members").select("id,pair_id,role,name,status").eq("token_hash", await sha256(t)).maybeSingle();
  if (!data) throw new ApiError("unauthorized", "この端末の登録が見つかりません。引き継ぎコードで復元するか、最初から登録してください。", 401);
  return data as Member;
}
// rate limits: count attempts per key in a time window (a network's IP or a device is stored only as a hash)
// the right-most address is the one added by the platform's own proxy (a client can only prepend fake ones)
const clientIp = (req: Request) => {
  const hops = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",").map((x) => x.trim()).filter(Boolean);
  const ip = hops[hops.length - 1] || "unknown";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip; // IPv6: count the whole /64 as one network
};
async function limit(req: Request, action: string, max = 5) {
  await limitKey(action + ":" + (await sha256("tsuki:" + clientIp(req))), max, 3600,
    "短い時間に何度も試されたため、一時的に止めています。1時間ほど待ってからもう一度お試しください。");
}
async function limitKey(key: string, max: number, windowSec: number, message: string) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  // record first, then count only the attempts recorded up to and including this one (ordered by id),
  // so in a burst exactly the first `max` pass and the rest are refused
  const { data: hit } = await sb.from("rate_hits").insert({ key }).select("id").single();
  const { count } = await sb.from("rate_hits").select("id", { count: "exact", head: true }).eq("key", key).gte("at", since).lte("id", hit?.id ?? 0);
  if (Math.random() < 0.02) await sb.from("rate_hits").delete().lt("at", new Date(Date.now() - 2 * 3600e3).toISOString());
  if ((count ?? 0) > max) throw new ApiError("rate_limited", message, 429);
}
const BUSY = "操作が続いたため、一時的に止めています。少し時間をおいてからもう一度お試しください。";
const ownerOnly = (m: Member) => { if (m.role !== "owner") throw new ApiError("forbidden", "記録する人だけが使える操作です。", 403); };

async function loadPair(pairId: string) {
  const { data, error } = await sb.from("pairs").select("id,invite_code,settings").eq("id", pairId).single();
  if (error) throw error;
  return { ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) } };
}
async function loadPeriods(pairId: string) {
  const { data, error } = await sb.from("periods").select("id,start_date,end_date,shared").eq("pair_id", pairId).order("start_date");
  if (error) throw error;
  return (data ?? []) as Period[];
}
// invite code exists only while the pair has no partner (active or pending)
async function refreshInvite(pairId: string) {
  const { count } = await sb.from("members").select("id", { count: "exact", head: true }).eq("pair_id", pairId).eq("role", "partner");
  if ((count ?? 0) === 0) await sb.from("pairs").update({ invite_code: randCode() }).eq("id", pairId).is("invite_code", null);
}
async function ownerName(pairId: string) {
  const { data } = await sb.from("members").select("name").eq("pair_id", pairId).eq("role", "owner").limit(1).maybeSingle();
  return data?.name || "パートナー";
}

/* ---------------- state ---------------- */
async function buildState(me: Member) {
  const today = todayJST();
  const pair = await loadPair(me.pair_id);
  const periods = await loadPeriods(me.pair_id);
  const stats = computeStats(periods, pair.settings, today);
  const { data: mems } = await sb.from("members").select("id,role,name,status,created_at").eq("pair_id", me.pair_id).order("created_at");
  const memIds = (mems ?? []).map((m) => m.id);
  const { data: subs } = memIds.length ? await sb.from("push_subs").select("member_id").in("member_id", memIds) : { data: [] };
  const subCount = (id: string) => (subs ?? []).filter((s) => s.member_id === id).length;
  const members = (mems ?? []).map((m) => ({ id: m.id, role: m.role, name: m.name, status: m.status, me: m.id === me.id, pushDevices: subCount(m.id) }));
  const { data: notices } = await sb.from("notices").select("kind,target,title,body,delivered,failed,created_at")
    .eq("pair_id", me.pair_id).order("created_at", { ascending: false }).limit(30);
  if (me.role === "owner") {
    const { data: days } = await sb.from("days").select("date,flow,symptoms,mood,others,memo").eq("pair_id", me.pair_id).order("date");
    return { today, me, inviteCode: pair.invite_code, settings: pair.settings, members, periods, days: days ?? [], stats, notices: notices ?? [] };
  }
  // partner: minimal view
  if (me.status !== "active") {
    return { today, me, members: members.filter((m) => m.me), pending: true, partnerView: { ownerName: await ownerName(me.pair_id), activeSince: null, next: null, predictions: [], sharePrediction: false }, notices: [] };
  }
  const active = stats.activeId ? periods.find((p) => p.id === stats.activeId) : null;
  let days: unknown[] | null = null;
  if (pair.settings.shareDays) { // the last ~4 months of 体調記録, memo only when allowed
    const { data } = await sb.from("days").select("date,flow,symptoms,mood,others,memo").eq("pair_id", me.pair_id).gte("date", addDays(today, -120)).order("date");
    days = (data ?? []).map((d) => (pair.settings.shareMemo ? d : { ...d, memo: "" }));
  }
  return {
    today, me, members, days,
    partnerView: {
      ownerName: await ownerName(me.pair_id),
      activeSince: active && active.shared !== false && pair.settings.notifyPartnerStart ? active.start_date : null,
      next: pair.settings.sharePrediction ? stats.next : null,
      predictions: pair.settings.sharePrediction ? stats.predictions.slice(0, 4) : [],
      sharePrediction: pair.settings.sharePrediction,
      pmsDays: pair.settings.sharePrediction && pair.settings.pmsNotify ? pair.settings.pmsDays : null,
    },
    notices: (notices ?? []).filter((n) => n.target === "partner" || n.target === "all"),
  };
}

/* ---------------- cron (daily reminders = substitute for local notifications) ---------------- */
async function runCron() {
  const today = todayJST();
  await sb.from("rate_hits").delete().lt("at", new Date(Date.now() - 864e5).toISOString()); // cleanup
  const { data: pairs } = await sb.from("pairs").select("id,settings");
  const out: unknown[] = [];
  for (const p of pairs ?? []) {
    const settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
    const periods = await loadPeriods(p.id);
    if (!periods.length) continue;
    const st = computeStats(periods, settings, today);
    if (!st.next || st.activeId) continue;
    const until = diff(today, st.next);
    const jobs: { kind: string; target: Target; title: string; body: string }[] = [];
    const name = await ownerName(p.id);
    if (until === 3 && settings.remindSelf3)
      jobs.push({ kind: "remind_self_3", target: "owner", title: "生理予定日まであと3日", body: `予定日は${fmt(st.next)}です。準備をしておきましょう。` });
    if (until === 0 && settings.remindSelfDay)
      jobs.push({ kind: "remind_self_day", target: "owner", title: "今日は生理予定日です", body: "始まったら「生理がきた」を押してください。" });
    const pmsDays = Math.min(10, Math.max(1, Number(settings.pmsDays) || 10));
    if (until === pmsDays && settings.pmsNotify)
      jobs.push({ kind: "pms_partner", target: "partner", title: `${name}の気分がゆらぎやすい時期に入りました`, body: settings.sharePrediction ? `生理予定日（${fmt(st.next)}）の${pmsDays}日前です。いつもより少し気づかってあげてください（目安）。` : "いつもより少し気づかってあげてください（目安）。" });
    if (until === 3 && settings.remindPartner3)
      jobs.push({ kind: "remind_partner_3", target: "partner", title: `${name}の生理予定日まであと3日`, body: `予定日は${fmt(st.next)}です（目安）。` });
    for (const j of jobs) {
      const { error } = await sb.from("reminders_sent").insert({ pair_id: p.id, kind: j.kind, target_date: st.next });
      if (error) continue; // already sent for this date
      out.push({ pair: p.id, kind: j.kind, ...(await pushTo(p.id, j.target, j.title, j.body, j.kind)) });
    }
  }
  return { today, sent: out };
}

/* ---------------- router ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, code: "method", message: "POST only" }, 405);
  // a browser on any other site is refused (server-to-server calls such as the daily job send no Origin)
  const origin = req.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) return json({ ok: false, code: "forbidden", message: "forbidden" }, 403);
  // refuse oversized requests before parsing them
  if (Number(req.headers.get("content-length") || 0) > 512 * 1024) return json({ ok: false, code: "too_large", message: "送信できる量を超えています。" }, 413);
  const raw = await req.text();
  if (raw.length > 512 * 1024) return json({ ok: false, code: "too_large", message: "送信できる量を超えています。" }, 413);
  let body: Record<string, any> = {};
  try { body = JSON.parse(raw || "{}"); } catch { /* empty */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  const action = String(body.action || "");
  try {
    // every call: at most 300 per 10 minutes from one network
    if (action !== "cron") await limitKey("all:" + (await sha256("tsuki:" + clientIp(req))), 300, 600, BUSY);
    switch (action) {
      case "vapid": {
        const s = await getSecrets();
        return json({ ok: true, publicKey: s.vapid_public });
      }
      case "cron": {
        const s = await getSecrets();
        const given = typeof body.secret === "string" ? body.secret : "";
        if (!s.cron_secret || !given || !safeEqual(await sha256(given), await sha256(s.cron_secret))) {
          await limitKey("cronfail:" + (await sha256("tsuki:" + clientIp(req))), 5, 3600, "forbidden");
          throw new ApiError("forbidden", "forbidden", 403);
        }
        return json({ ok: true, ...(await runCron()) });
      }
      case "setup_owner": {
        await limit(req, "setup_owner");
        const name = String(body.name || "").trim().slice(0, 20);
        if (!name) throw new ApiError("bad_request", "呼び名を入力してください。");
        let pair = null;
        for (let i = 0; i < 5 && !pair; i++) {
          const { data } = await sb.from("pairs").insert({ invite_code: randCode(), settings: {} }).select("id,invite_code").single();
          pair = data;
        }
        if (!pair) throw new ApiError("server", "登録に失敗しました。もう一度お試しください。", 500);
        const token = randToken();
        await sb.from("members").insert({ pair_id: pair.id, role: "owner", name, token_hash: await sha256(token) });
        return json({ ok: true, token });
      }
      case "join": {
        await limit(req, "join");
        const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        const name = String(body.name || "").trim().slice(0, 20);
        if (!name) throw new ApiError("bad_request", "呼び名を入力してください。");
        // single-use code: claim it atomically by rotating it (a second simultaneous use finds no match)
        const { data: pair } = code.length >= 6
          ? await sb.from("pairs").update({ invite_code: null }).eq("invite_code", code).select("id").maybeSingle()
          : { data: null };
        if (!pair) throw new ApiError("not_found", "招待コードが見つかりません。コードは1回使うと変わります。記録する人の画面の「設定」にある最新のコードを確認してください。", 404);
        const token = randToken();
        await sb.from("members").insert({ pair_id: pair.id, role: "partner", name, status: "pending", token_hash: await sha256(token) });
        const owner = await ownerName(pair.id);
        await pushTo(pair.id, "owner", "参加リクエストが届きました", `${hon(name)}がパートナーとして参加を希望しています。「設定」で承認してください。`, "join_request");
        return json({ ok: true, token, ownerName: owner });
      }
    }

    if (action === "redeem") {
      await limit(req, "redeem", 10);
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
      if (code.length < 12) throw new ApiError("not_found", "引き継ぎコードが正しくないか、有効期限が切れています。", 404);
      const { data: tc } = await sb.from("transfer_codes").delete().eq("code_hash", await sha256(code)).gt("expires_at", new Date().toISOString()).select("member_id").maybeSingle();
      if (!tc) throw new ApiError("not_found", "引き継ぎコードが正しくないか、有効期限が切れています。", 404);
      // new token for the new phone; the old phone's token stops working and its notifications are removed
      const token = randToken();
      await sb.from("members").update({ token_hash: await sha256(token) }).eq("id", tc.member_id);
      await sb.from("push_subs").delete().eq("member_id", tc.member_id);
      await sb.from("transfer_codes").delete().eq("member_id", tc.member_id);
      return json({ ok: true, token });
    }

    const me = await auth(req);
    // every signed-in call: at most 150 per 10 minutes per person
    await limitKey("member:" + me.id, 150, 600, BUSY);
    if (me.status !== "active" && !["state", "subscribe", "unsubscribe", "test_push", "leave", "transfer_code"].includes(action))
      throw new ApiError("pending", "記録する人の承認を待っています。", 403);
    switch (action) {
      case "state":
        return json({ ok: true, state: await buildState(me) });

      case "subscribe": {
        const s = body.subscription;
        const ep = typeof s?.endpoint === "string" ? s.endpoint : "", k1 = s?.keys?.p256dh, k2 = s?.keys?.auth;
        let host = "";
        try { const u = new URL(ep); if (u.protocol === "https:") host = u.hostname; } catch { /* invalid */ }
        const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
        if (!host || !PUSH_HOSTS.some((r) => r.test(host)) || ep.length > 1024 || typeof k1 !== "string" || typeof k2 !== "string" || k1.length > 200 || k2.length > 100)
          throw new ApiError("bad_request", "通知の登録情報が不正です。");
        const { data: owner } = await sb.from("push_subs").select("member_id").eq("endpoint", ep).maybeSingle();
        if (owner && owner.member_id !== me.id) throw new ApiError("conflict", "この携帯の通知はほかの登録で使われています。", 409);
        await sb.from("push_subs").upsert({ member_id: me.id, endpoint: ep, p256dh: k1, auth: k2 }, { onConflict: "endpoint" });
        const { data: mine } = await sb.from("push_subs").select("id,created_at").eq("member_id", me.id).order("created_at", { ascending: false });
        const extra = (mine ?? []).slice(3).map((x) => x.id);
        if (extra.length) await sb.from("push_subs").delete().in("id", extra);
        return json({ ok: true });
      }
      case "unsubscribe": {
        if (body.endpoint) await sb.from("push_subs").delete().eq("endpoint", String(body.endpoint)).eq("member_id", me.id);
        return json({ ok: true });
      }
      case "test_push": {
        const r = await pushTo(me.pair_id, { member: me.id }, "テスト通知", "つきのしらせ からの通知は、このように届きます。", "test");
        return json({ ok: true, result: r });
      }
      case "transfer_code": {
        // a one-time code valid for 60 minutes; the current phone keeps working until it is used
        const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const b = crypto.getRandomValues(new Uint8Array(16));
        const code = Array.from(b).map((x) => A[x % A.length]).join("");
        await sb.from("transfer_codes").delete().eq("member_id", me.id);
        await sb.from("transfer_codes").insert({ code_hash: await sha256(code), member_id: me.id, expires_at: new Date(Date.now() + 3600e3).toISOString() });
        return json({ ok: true, code: code.replace(/(.{4})(?=.)/g, "$1-"), minutes: 60 });
      }
      case "rename": {
        const name = String(body.name || "").trim().slice(0, 20);
        if (!name) throw new ApiError("bad_request", "呼び名を入力してください。");
        await sb.from("members").update({ name }).eq("id", me.id);
        return json({ ok: true, state: await buildState(me) });
      }
      case "leave": {
        if (me.role === "owner") throw new ApiError("forbidden", "記録する人は「すべてのデータを削除」を使ってください。", 403);
        await sb.from("members").delete().eq("id", me.id);
        await refreshInvite(me.pair_id);
        return json({ ok: true });
      }
    }

    ownerOnly(me);
    const today = todayJST();
    switch (action) {
      case "period_start": {
        const date = isDate(body.date) ? body.date : today;
        if (diff(date, today) < 0) throw new ApiError("bad_request", "未来の日付は選べません。");
        const periods = await loadPeriods(me.pair_id);
        const near = periods.find((p) => Math.abs(diff(p.start_date, date)) < 10);
        if (near && !body.force) throw new ApiError("duplicate", `${fmt(near.start_date)} 開始の記録がすでにあります。`, 409);
        if (periods.length >= MAX_PERIODS) throw new ApiError("too_many", "記録の上限に達しています。", 409);
        const pair = await loadPair(me.pair_id);
        const shared = body.notify !== false && !!pair.settings.notifyPartnerStart;
        const { data: ins, error } = await sb.from("periods").insert({ pair_id: me.pair_id, start_date: date, shared }).select("id").single();
        if (error) throw error;
        const st = computeStats([...periods, { id: ins.id, start_date: date, end_date: null, shared }], pair.settings, today);
        let push = null;
        if (shared) {
          push = await pushTo(me.pair_id, "partner", "生理が始まりました", `${me.name}の生理が${fmt(date)}に始まりました。体調を気づかってあげてください。`, "period_start");
        }
        return json({ ok: true, summary: { start: date, expectedLen: st.avgLen, expectedEnd: addDays(date, st.avgLen - 1), avgCycle: st.avgCycle, cycleSource: st.cycleSource, next: st.next }, push, state: await buildState(me) });
      }
      case "period_end": {
        const date = isDate(body.date) ? body.date : today;
        const { data: p } = await sb.from("periods").select("id,start_date").eq("id", String(body.id)).eq("pair_id", me.pair_id).maybeSingle();
        if (!p) throw new ApiError("not_found", "対象の記録が見つかりません。");
        if (diff(p.start_date, date) < 0 || diff(date, today) < 0) throw new ApiError("bad_request", "終了日は開始日から今日までの間で選んでください。");
        const { error: upErr } = await sb.from("periods").update({ end_date: date }).eq("id", p.id);
        if (upErr) throw upErr;
        const pair = await loadPair(me.pair_id);
        const st = computeStats(await loadPeriods(me.pair_id), pair.settings, today);
        let push = null;
        if (body.notify !== false && pair.settings.notifyPartnerEnd) {
          push = await pushTo(me.pair_id, "partner", "生理が終わりました", `${me.name}の生理が${fmt(date)}に終わりました。`, "period_end");
        }
        return json({ ok: true, summary: { start: p.start_date, end: date, length: diff(p.start_date, date) + 1, avgCycle: st.avgCycle, avgLen: st.avgLen, next: st.next }, push, state: await buildState(me) });
      }
      case "period_upsert": {
        const start = body.start, end = body.end || null;
        if (!isDate(start) || (end && !isDate(end))) throw new ApiError("bad_request", "日付を正しく入力してください。");
        if (diff(start, today) < 0 || (end && diff(end, today) < 0)) throw new ApiError("bad_request", "未来の日付は選べません。");
        if (end && (diff(start, end) < 0 || diff(start, end) > 13)) throw new ApiError("bad_request", "終了日は開始日から14日以内にしてください。");
        const periods = await loadPeriods(me.pair_id);
        const near = periods.find((p) => p.id !== body.id && Math.abs(diff(p.start_date, start)) < 10);
        if (near) throw new ApiError("duplicate", `${fmt(near.start_date)} 開始の記録と近すぎます。`, 409);
        if (body.id) await sb.from("periods").update({ start_date: start, end_date: end }).eq("id", String(body.id)).eq("pair_id", me.pair_id);
        else {
          if (periods.length >= MAX_PERIODS) throw new ApiError("too_many", "記録の上限に達しています。", 409);
          await sb.from("periods").insert({ pair_id: me.pair_id, start_date: start, end_date: end });
        }
        return json({ ok: true, state: await buildState(me) });
      }
      case "period_delete": {
        await sb.from("periods").delete().eq("id", String(body.id)).eq("pair_id", me.pair_id);
        return json({ ok: true, state: await buildState(me) });
      }
      case "day_save": {
        if (!isDate(body.date) || diff(body.date, today) < 0) throw new ApiError("bad_request", "日付が不正です。");
        const { count: dayCount } = await sb.from("days").select("date", { count: "exact", head: true }).eq("pair_id", me.pair_id);
        if ((dayCount ?? 0) >= MAX_DAYS) {
          const { data: exists } = await sb.from("days").select("date").eq("pair_id", me.pair_id).eq("date", body.date).maybeSingle();
          if (!exists) throw new ApiError("too_many", "記録の上限に達しています。", 409);
        }
        await sb.from("days").upsert(dayRow(me.pair_id, body), { onConflict: "pair_id,date" });
        return json({ ok: true, state: await buildState(me) });
      }
      case "day_delete": {
        await sb.from("days").delete().eq("pair_id", me.pair_id).eq("date", String(body.date));
        return json({ ok: true, state: await buildState(me) });
      }
      case "settings_save": {
        // build a patch of only the changed (and valid) keys, then merge it atomically in the database,
        // so two saves at the same moment never wipe each other's changes
        const patch: Record<string, unknown> = {};
        if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new ApiError("bad_request", "設定の内容が不正です。");
        for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
          if (!(k in (body.settings ?? {}))) continue;
          const v = body.settings[k];
          if (k === "defCycle") { const n = Number(v); if (n >= 15 && n <= 60) patch.defCycle = n; }
          else if (k === "defLen") { const n = Number(v); if (n >= 1 && n <= 14) patch.defLen = n; }
          else if (k === "pmsDays") { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 10) patch.pmsDays = n; }
          else if (k === "otherWords") {
            if (Array.isArray(v)) patch.otherWords = [...new Set(v.map((x: unknown) => String(x).trim().slice(0, 20)).filter(Boolean))].slice(0, 30);
          }
          else patch[k] = !!v;
        }
        if (Object.keys(patch).length) {
          const { error } = await sb.rpc("merge_settings", { p_pair: me.pair_id, p_patch: patch });
          if (error) throw error;
        }
        return json({ ok: true, state: await buildState(me) });
      }
      case "test_partner": {
        const r = await pushTo(me.pair_id, "partner", "テスト通知", `${hon(me.name)}の「つきのしらせ」からのテスト通知です。`, "test_partner");
        return json({ ok: true, result: r });
      }
      case "regen_invite": {
        const { count } = await sb.from("members").select("id", { count: "exact", head: true }).eq("pair_id", me.pair_id).eq("role", "partner");
        if ((count ?? 0) > 0) throw new ApiError("has_partner", "パートナーが登録済み（または承認待ち）のため、招待コードは発行できません。", 409);
        await sb.from("pairs").update({ invite_code: randCode() }).eq("id", me.pair_id);
        return json({ ok: true, state: await buildState(me) });
      }
      case "approve_member": {
        const { data: m } = await sb.from("members").update({ status: "active" }).eq("id", String(body.id)).eq("pair_id", me.pair_id).eq("role", "partner").select("id,name").maybeSingle();
        if (!m) throw new ApiError("not_found", "対象のパートナーが見つかりません。");
        await pushTo(me.pair_id, { member: m.id }, "参加が承認されました", `${hon(me.name)}の「つきのしらせ」に参加しました。`, "approved");
        return json({ ok: true, state: await buildState(me) });
      }
      case "remove_member": {
        await sb.from("members").delete().eq("id", String(body.id)).eq("pair_id", me.pair_id).eq("role", "partner");
        await refreshInvite(me.pair_id);
        return json({ ok: true, state: await buildState(me) });
      }
      case "import": {
        const ps = Array.isArray(body.periods) ? body.periods.slice(0, 500) : [];
        const ds = Array.isArray(body.days) ? body.days.slice(0, 3000) : [];
        let n = 0;
        const existing = await loadPeriods(me.pair_id);
        for (const p of ps) {
          if (!p || typeof p !== "object" || !isDate(p.start) || diff(p.start, today) < 0) continue;
          if (existing.length >= MAX_PERIODS || existing.some((e) => Math.abs(diff(e.start_date, p.start)) < 10)) continue;
          const end = isDate(p.end) && diff(p.start, p.end) >= 0 && diff(p.start, p.end) <= 13 && diff(p.end, today) >= 0 ? p.end : null;
          await sb.from("periods").insert({ pair_id: me.pair_id, start_date: p.start, end_date: end });
          existing.push({ id: "", start_date: p.start, end_date: end }); n++;
        }
        const rows = ds.filter((d: unknown) => d && typeof d === "object" && isDate((d as Record<string, unknown>).date) && diff((d as Record<string, string>).date, today) >= 0)
          .map((d: Record<string, unknown>) => dayRow(me.pair_id, d));
        const byDate = new Map(rows.map((r: { date: string }) => [r.date, r])); // one row per date
        const { count: have } = await sb.from("days").select("date", { count: "exact", head: true }).eq("pair_id", me.pair_id);
        rows.length = 0; rows.push(...[...byDate.values()].slice(0, Math.max(0, MAX_DAYS - (have ?? 0))));
        for (let i = 0; i < rows.length; i += 200) {
          await sb.from("days").upsert(rows.slice(i, i + 200), { onConflict: "pair_id,date" });
        }
        n += rows.length;
        return json({ ok: true, imported: n, state: await buildState(me) });
      }
      case "delete_all": {
        if (body.confirm !== "DELETE") throw new ApiError("bad_request", "削除の確認ができませんでした。", 400);
        await sb.from("pairs").delete().eq("id", me.pair_id); // cascades to everything
        return json({ ok: true });
      }
    }
    throw new ApiError("unknown_action", "不明な操作です: " + action, 400);
  } catch (e) {
    if (e instanceof ApiError) return json({ ok: false, code: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ ok: false, code: "server", message: "サーバーでエラーが起きました。少し待ってからもう一度お試しください。" }, 500);
  }
});
