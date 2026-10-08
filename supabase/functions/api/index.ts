// つきのしらせ API (Supabase Edge Function)
// All data access goes through here with the service role; tables have RLS on and no policies.
// Auth: each device holds a random token; only its SHA-256 hash is stored.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
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
  return { recipients, delivered, failed, errors };
}

/* ---------------- dates & stats ---------------- */
// add さん unless the name already ends with an honorific (まりちゃん, あっくん …)
const hon = (n: string) => (/(さん|ちゃん|くん|君|様|さま|たん|氏|ちん)$/.test(n) ? n : n + "さん");
const pad = (n: number) => String(n).padStart(2, "0");
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
type Period = { id: string; start_date: string; end_date: string | null };

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
// rate limit for the public entry points: max N attempts per hour per network (IP is stored only as a hash)
async function limit(req: Request, action: string, max = 5) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",")[0].trim();
  const key = action + ":" + (await sha256("tsuki:" + ip));
  const since = new Date(Date.now() - 3600e3).toISOString();
  // record first, then count only the attempts recorded up to and including this one (ordered by id),
  // so in a burst exactly the first `max` pass and the rest are refused
  const { data: hit } = await sb.from("rate_hits").insert({ key }).select("id").single();
  const { count } = await sb.from("rate_hits").select("id", { count: "exact", head: true }).eq("key", key).gte("at", since).lte("id", hit?.id ?? 0);
  if ((count ?? 0) > max)
    throw new ApiError("rate_limited", "短い時間に何度も試されたため、一時的に止めています。1時間ほど待ってからもう一度お試しください。", 429);
}
const ownerOnly = (m: Member) => { if (m.role !== "owner") throw new ApiError("forbidden", "記録する人だけが使える操作です。", 403); };

async function loadPair(pairId: string) {
  const { data, error } = await sb.from("pairs").select("id,invite_code,settings").eq("id", pairId).single();
  if (error) throw error;
  return { ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) } };
}
async function loadPeriods(pairId: string) {
  const { data, error } = await sb.from("periods").select("id,start_date,end_date").eq("pair_id", pairId).order("start_date");
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
      activeSince: active?.start_date ?? null,
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
      jobs.push({ kind: "pms_partner", target: "partner", title: `${name}の気分がゆらぎやすい時期に入りました`, body: `生理予定日（${fmt(st.next)}）の${pmsDays}日前です。いつもより少し気づかってあげてください（目安）。` });
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
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "");
  try {
    switch (action) {
      case "vapid": {
        const s = await getSecrets();
        return json({ ok: true, publicKey: s.vapid_public });
      }
      case "cron": {
        const s = await getSecrets();
        if (body.secret !== s.cron_secret) throw new ApiError("forbidden", "bad secret", 403);
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

    const me = await auth(req);
    if (me.status !== "active" && !["state", "subscribe", "unsubscribe", "test_push", "leave", "claim"].includes(action))
      throw new ApiError("pending", "記録する人の承認を待っています。", 403);
    switch (action) {
      case "state":
        return json({ ok: true, state: await buildState(me) });

      case "subscribe": {
        const s = body.subscription;
        if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) throw new ApiError("bad_request", "通知の登録情報が不正です。");
        await sb.from("push_subs").upsert({ member_id: me.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, { onConflict: "endpoint" });
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
      case "claim": {
        // a device takes over this member with a transfer code: issue a fresh token so every other device
        // holding the old one is signed out, and drop old devices' push registrations (one phone per person)
        const token = randToken();
        await sb.from("members").update({ token_hash: await sha256(token) }).eq("id", me.id);
        await sb.from("push_subs").delete().eq("member_id", me.id);
        return json({ ok: true, token });
      }
      case "transfer_code": {
        // issue a fresh token for moving to a new phone; old token stops working
        const token = randToken();
        await sb.from("members").update({ token_hash: await sha256(token) }).eq("id", me.id);
        return json({ ok: true, token });
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
        const { data: ins, error } = await sb.from("periods").insert({ pair_id: me.pair_id, start_date: date }).select("id").single();
        if (error) throw error;
        const pair = await loadPair(me.pair_id);
        const st = computeStats([...periods, { id: ins.id, start_date: date, end_date: null }], pair.settings, today);
        let push = null;
        if (body.notify !== false && pair.settings.notifyPartnerStart) {
          push = await pushTo(me.pair_id, "partner", "生理が始まりました", `${me.name}の生理が${fmt(date)}に始まりました。体調を気づかってあげてください。`, "period_start");
        }
        return json({ ok: true, summary: { start: date, expectedLen: st.avgLen, expectedEnd: addDays(date, st.avgLen - 1), avgCycle: st.avgCycle, cycleSource: st.cycleSource, next: st.next }, push, state: await buildState(me) });
      }
      case "period_end": {
        const date = isDate(body.date) ? body.date : today;
        const { data: p } = await sb.from("periods").select("id,start_date").eq("id", String(body.id)).eq("pair_id", me.pair_id).maybeSingle();
        if (!p) throw new ApiError("not_found", "対象の記録が見つかりません。");
        if (diff(p.start_date, date) < 0 || diff(date, today) < 0) throw new ApiError("bad_request", "終了日は開始日から今日までの間で選んでください。");
        await sb.from("periods").update({ end_date: date }).eq("id", p.id);
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
        else await sb.from("periods").insert({ pair_id: me.pair_id, start_date: start, end_date: end });
        return json({ ok: true, state: await buildState(me) });
      }
      case "period_delete": {
        await sb.from("periods").delete().eq("id", String(body.id)).eq("pair_id", me.pair_id);
        return json({ ok: true, state: await buildState(me) });
      }
      case "day_save": {
        if (!isDate(body.date)) throw new ApiError("bad_request", "日付が不正です。");
        const row = {
          pair_id: me.pair_id, date: body.date,
          flow: body.flow || null, mood: body.mood ? String(body.mood).slice(0, 200) : null,
          symptoms: Array.isArray(body.symptoms) ? body.symptoms.map(String).slice(0, 20) : [],
          others: Array.isArray(body.others) ? body.others.map((x: unknown) => String(x).slice(0, 30)).slice(0, 30) : [],
          memo: String(body.memo || "").slice(0, 1000), updated_at: new Date().toISOString(),
        };
        await sb.from("days").upsert(row, { onConflict: "pair_id,date" });
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
        const ps = Array.isArray(body.periods) ? body.periods : [];
        const ds = Array.isArray(body.days) ? body.days : [];
        let n = 0;
        const existing = await loadPeriods(me.pair_id);
        for (const p of ps) {
          if (!isDate(p.start) || existing.some((e) => Math.abs(diff(e.start_date, p.start)) < 10)) continue;
          await sb.from("periods").insert({ pair_id: me.pair_id, start_date: p.start, end_date: isDate(p.end) ? p.end : null });
          existing.push({ id: "", start_date: p.start, end_date: null }); n++;
        }
        for (const d of ds) {
          if (!isDate(d.date)) continue;
          await sb.from("days").upsert({ pair_id: me.pair_id, date: d.date, flow: d.flow || null, mood: d.mood || null,
            symptoms: Array.isArray(d.symptoms) ? d.symptoms : [], others: Array.isArray(d.others) ? d.others : [], memo: d.memo || "" }, { onConflict: "pair_id,date" });
          n++;
        }
        return json({ ok: true, imported: n, state: await buildState(me) });
      }
      case "delete_all": {
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
