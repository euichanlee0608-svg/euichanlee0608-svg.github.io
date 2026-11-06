// pf-profile — 포트폴리오의 개인정보 공개 스위치 + 방문자 연락 요청 창구.
//
//   app_secrets.pf_show     {"email":bool,"github":bool,"linkedin":bool,"cv":"on"|"off"|"request"}  무엇을 보여 줄지(기본 = 익명 + 이력서는 요청제)
//                           cv: on=PDF 저장 버튼 · off=이력서 버튼 없음 · request=이력서 요청 버튼(2026-11-07). 옛 bool 은 true→on, 그 밖→request
//   app_secrets.pf_values   {"email","github","linkedin"} 실제 값. 페이지 소스에는 두지 않는다 — 켜진 것만 get 으로 나간다
//   app_secrets.webapp_notify_admin  바꾸기용 토큰(텔레그램 봇 .env 의 WEBAPP_NOTIFY_TOKEN, 킬스위치와 공용)
//   public.pf_contacts      방문자 연락 요청(서비스 롤만 읽고 씀, RLS 정책 없음)
//
// actions
//   get     {}                                     → {show, values(켜진 것만)}           누구나
//   set     {token, field, on} | {token, field:"cv", mode} → {show}                      COT봇 /pf_privacy
//   contact {email, message, kind?, name?, lang?, page?, hp?} → {ok}                     누구나(일일 캡·IP당 캡)
//           kind:"cv" = 이력서 요청(메시지 선택, 저장 시 앞에 [이력서 요청]) — 2026-11-07 CV 는 요청제로
//   list    {token, n?}                            → {items:[...]}                       COT봇 /pf_privacy
// 원본 = ~/webapps/portfolio/supabase/functions/pf-profile/index.ts (배포는 Supabase MCP, verify_jwt 끔)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const FIELDS = ["email", "github", "linkedin"] as const;
const CV_MODES = ["on", "off", "request"];
const cvMode = (v: unknown) => (v === true ? "on" : CV_MODES.includes(String(v)) ? String(v) : "request");
const DAILY_CAP = 40;      // 전체 하루 연락 요청 상한
const PER_IP_CAP = 3;      // 같은 IP 하루 상한
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { /* 빈 몸 */ }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data } = await db.from("app_secrets").select("key,value").in("key",
    ["pf_show", "pf_values", "webapp_notify_admin", "webapp_notify_off", "telegram_notify_token", "telegram_owner_chat"]);
  const g = (k: string) => data?.find((x: { key: string }) => x.key === k)?.value ?? "";
  let show: Record<string, unknown> = {}, values: Record<string, string> = {};
  try { show = JSON.parse(g("pf_show") || "{}"); } catch { /* 깨지면 전부 꺼짐 */ }
  try { values = JSON.parse(g("pf_values") || "{}"); } catch { /* */ }
  const view = () => {
    const s: Record<string, boolean | string> = Object.fromEntries(FIELDS.map((f) => [f, show[f] === true]));
    const v = Object.fromEntries(Object.entries(values).filter(([k]) => s[k] === true));
    s.cv = cvMode(show.cv);
    return { show: s, values: v };
  };
  const admin = () => !!g("webapp_notify_admin") && String(body.token ?? "") === g("webapp_notify_admin");

  if (body.action === "set") {
    if (!admin()) return json({ error: "unauthorized" }, 401);
    const f = String(body.field ?? "");
    if (f === "*") { FIELDS.forEach((k) => (show[k] = body.on === true)); show.cv = body.on === true ? "on" : "off"; }
    else if (f === "cv") {
      const m = body.mode !== undefined ? String(body.mode) : (body.on === true ? "on" : "off");
      if (!CV_MODES.includes(m)) return json({ error: "unknown mode" }, 400);
      show.cv = m;
    }
    else if ((FIELDS as readonly string[]).includes(f)) show[f] = body.on === true;
    else return json({ error: "unknown field" }, 400);
    await db.from("app_secrets").upsert({ key: "pf_show", value: JSON.stringify(view().show) });
    return json(view());
  }

  if (body.action === "list") {
    if (!admin()) return json({ error: "unauthorized" }, 401);
    const n = Math.min(Math.max(Number(body.n ?? 5), 1), 20);
    const { data: items } = await db.from("pf_contacts").select("created_at,email,name,message,lang,page")
      .order("created_at", { ascending: false }).limit(n);
    const { count } = await db.from("pf_contacts").select("id", { count: "exact", head: true });
    return json({ items: items ?? [], total: count ?? 0 });
  }

  if (body.action === "contact") {
    if (String(body.hp ?? "")) return json({ ok: true });           // 봇: 조용히 성공한 척
    const email = String(body.email ?? "").trim().slice(0, 254);
    const cv = body.kind === "cv";
    const note = String(body.message ?? "").trim();
    const message = cv ? ("[이력서 요청]" + (note ? " " + note : "")) : note;
    const name = String(body.name ?? "").trim().slice(0, 120);
    if (!EMAIL_RE.test(email)) return json({ error: "bad_email" }, 400);
    if (!cv && message.length < 5) return json({ error: "short_message" }, 400);
    if (message.length > 2000) return json({ error: "long_message" }, 400);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
    const ipHash = ip ? await sha(ip + "pf") : "";
    const since = new Date(Date.now() - 86400_000).toISOString();
    const { count: day } = await db.from("pf_contacts").select("id", { count: "exact", head: true }).gte("created_at", since);
    if ((day ?? 0) >= DAILY_CAP) return json({ error: "busy" }, 429);
    if (ipHash) {
      const { count: mine } = await db.from("pf_contacts").select("id", { count: "exact", head: true })
        .gte("created_at", since).eq("ip_hash", ipHash);
      if ((mine ?? 0) >= PER_IP_CAP) return json({ error: "limit" }, 429);
    }
    const lang = String(body.lang ?? "").slice(0, 5), page = String(body.page ?? "").slice(0, 60);
    const { error } = await db.from("pf_contacts").insert({ email, name: name || null, message, lang, page, ip_hash: ipHash });
    if (error) return json({ error: "store_failed" }, 500);
    // 알림(COT봇). 저장은 이미 끝났으니 알림이 꺼져 있거나 실패해도 요청은 남는다 — /pf_privacy 에서 본다
    const off = g("webapp_notify_off").split(",").map((x: string) => x.trim());
    if (!off.includes("*") && !off.includes("portfolio") && g("telegram_notify_token") && g("telegram_owner_chat")) {
      const text = `${cv ? "📄 [포트폴리오] 이력서 열람 요청" : "📬 [포트폴리오] 연락 요청"}\n보낸 사람: ${name || "(이름 없음)"} <${email}>\n언어: ${lang} · ${page}\n\n${message.slice(0, 1500)}`;
      EdgeRuntime.waitUntil(fetch(`https://api.telegram.org/bot${g("telegram_notify_token")}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: g("telegram_owner_chat"), text, disable_web_page_preview: true }),
      }).catch(() => {}));
    }
    return json({ ok: true });
  }

  return json(view());
});
