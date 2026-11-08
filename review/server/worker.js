/**
 * 리뷰 공방 서버 (Cloudflare Worker, 외부 의존성 없음)
 *
 * 역할
 *  - 아내 폰 앱(review/index.html)의 REST 백엔드:  /api/...   (헤더 X-Key 또는 ?k=; 사진 태그는 ?tag= URL 인코딩)
 *  - 아내 피클(Claude 앱 커넥터)의 MCP 서버:        /mcp/<키>   (Streamable HTTP, JSON-RPC)
 *  - 저장은 전부 GitHub 비공개 저장소(Contents API). GitHub 토큰은 이 서버 안에만 있음.
 *
 * 환경 변수 (Workers → Settings → Variables and Secrets)
 *  secrets: GH_TOKEN (fine-grained PAT: Contents RW, Issues RW, Pull requests RW on GH_REPO)
 *           KEY_WIFE, KEY_HUSBAND (각 32자 이상 무작위 문자열; 사람마다 하나)
 *  vars:    GH_REPO="HoonStar/review-lab-inbox"  GH_BRANCH="main"
 *           APP_URL="https://hoonstar.github.io/yojeum-lab-feed/review/"
 *           WAKE_PR="1" (알림 PR 번호; 없으면 비움)  APP_NAME="리뷰 공방"
 */

const GH = "https://api.github.com";
const CATS = ["식품","생활주방","의류잡화","뷰티","가전디지털","육아반려","가구인테리어","스포츠레저","도서문구","기타"];
const PERIODS = ["당일","2~3일","1주","2주","1개월","3개월 이상"];
const TAGS = ["전체","비교","디테일","사용","결과","포장","단점"];
const STATUS = { collected:"사진·메모 필요", mismatch:"사진 확인 필요", ready:"작성 대기", drafting:"작성 중", drafted:"리뷰 완성", posted:"게시됨", skipped:"건너뜀" };
const CORS = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, X-Key, X-Tag, Accept, Mcp-Session-Id, Mcp-Protocol-Version", "Access-Control-Allow-Methods":"GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Max-Age":"86400" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === "/" ) return text("리뷰 공방 서버입니다. 열쇠가 있는 링크로 들어오세요.", 200);
      if (url.pathname === "/app") { const acct = keyAccount(env, url.searchParams.get("k")); if (!acct) return text("열쇠가 맞지 않아요.", 401); return Response.redirect((env.APP_URL || "") + "#s=" + encodeURIComponent(url.origin) + "&k=" + encodeURIComponent(url.searchParams.get("k")), 302); }
      if (url.pathname.startsWith("/mcp/")) { const key = decodeURIComponent(url.pathname.slice(5).split("/")[0]); const acct = keyAccount(env, key); if (!acct) return text("not found", 404); return mcp(request, env, acct, key); }
      if (url.pathname.startsWith("/api/")) { const key = request.headers.get("X-Key") || url.searchParams.get("k"); const acct = keyAccount(env, key); if (!acct) return json({ error: "열쇠가 맞지 않아요." }, 401); return api(request, env, acct, url); }
      return text("not found", 404);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      return json({ error: "서버 오류: " + msg }, 500);
    }
  }
};

// ---------- helpers ----------
const text = (s, status = 200, headers = {}) => new Response(s, { status, headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, CORS, headers) });
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS, headers) });
function keyAccount(env, key) { if (!key || key.length < 16) return null; if (env.KEY_WIFE && key === env.KEY_WIFE) return "wife"; if (env.KEY_HUSBAND && key === env.KEY_HUSBAND) return "husband"; return null; }
const nowIso = () => new Date().toISOString();
const kst = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);
function newId() { return "it_" + kst().replace(/-/g, "").slice(2) + "_" + Math.random().toString(36).slice(2, 7); }
function b64encode(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function b64encodeText(str) { return b64encode(new TextEncoder().encode(str)); }
function b64decodeText(b64) { const bin = atob((b64 || "").replace(/\n/g, "")); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); }
const encPath = p => p.split("/").map(encodeURIComponent).join("/");
function daysSince(ymd) { if (!ymd) return null; const a = new Date(ymd.slice(0, 10) + "T00:00:00+09:00"), b = new Date(kst() + "T00:00:00+09:00"); return Math.round((b - a) / 86400000); }
function addDays(ymd, n) { const d = new Date(ymd.slice(0, 10) + "T00:00:00+09:00"); d.setDate(d.getDate() + n); return kst(d); }

// ---------- GitHub contents ----------
async function gh(env, path, init = {}) {
  const r = await fetch(GH + path, Object.assign({}, init, { headers: Object.assign({ "Authorization": "Bearer " + env.GH_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "review-lab-worker" }, init.headers || {}) }));
  return r;
}
const branch = env => env.GH_BRANCH || "main";
async function getFile(env, path) { const r = await gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}?ref=${branch(env)}`); if (r.status === 404) return null; if (!r.ok) throw new Error("GitHub 읽기 실패 " + r.status + " " + path); const j = await r.json(); return { sha: j.sha, text: b64decodeText(j.content) }; }
async function getJson(env, path) { const f = await getFile(env, path); if (!f) return null; try { return { sha: f.sha, data: JSON.parse(f.text) }; } catch (e) { return null; } }
async function getRaw(env, path) { return gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}?ref=${branch(env)}`, { headers: { "Accept": "application/vnd.github.raw+json" } }); }
async function listDir(env, path) { const r = await gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}?ref=${branch(env)}`); if (r.status === 404) return []; if (!r.ok) throw new Error("GitHub 목록 실패 " + r.status); const a = await r.json(); return Array.isArray(a) ? a : []; }
async function putFile(env, path, base64, message, sha) {
  const body = { message, content: base64, branch: branch(env) }; if (sha) body.sha = sha;
  const r = await gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}`, { method: "PUT", body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) { const t = await r.text(); const e = new Error("conflict " + t); e.code = "conflict"; throw e; }
  if (!r.ok) throw new Error("GitHub 쓰기 실패 " + r.status + " " + path + " " + (await r.text()).slice(0, 200));
  const j = await r.json(); return j.content.sha;
}
async function deleteFile(env, path, message) { const f = await gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}?ref=${branch(env)}`); if (f.status === 404) return; const j = await f.json(); const r = await gh(env, `/repos/${env.GH_REPO}/contents/${encPath(path)}`, { method: "DELETE", body: JSON.stringify({ message, sha: j.sha, branch: branch(env) }) }); if (!r.ok && r.status !== 404) throw new Error("GitHub 삭제 실패 " + r.status); }
async function mutateJson(env, path, mutate, message) {
  for (let i = 0; i < 4; i++) {
    const cur = await getJson(env, path); const next = mutate(cur ? cur.data : null);
    try { await putFile(env, path, b64encodeText(JSON.stringify(next, null, 2) + "\n"), message, cur ? cur.sha : undefined); return next; }
    catch (e) { if (e.code !== "conflict" || i === 3) throw e; }
  }
}
// ---------- Git Data API: 여러 파일을 한 번의 커밋으로 ----------
async function ghJson(env, path, init = {}) { const r = await gh(env, path, init); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} if (!r.ok) { const e = new Error("GitHub " + r.status + " " + path + " " + t.slice(0, 160)); e.status = r.status; throw e; } return j; }
async function commitFiles(env, files, message) {
  // files: [{path, base64}] (binary) 또는 [{path, content}] (text). 비-fast-forward면 최대 3회 재시도.
  const repo = env.GH_REPO, br = branch(env);
  const blobs = await Promise.all(files.map(async f => f.base64 ? { path: f.path, sha: (await ghJson(env, `/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: f.base64, encoding: "base64" }) })).sha } : { path: f.path, content: f.content }));
  for (let i = 0; i < 3; i++) {
    const head = (await ghJson(env, `/repos/${repo}/git/ref/heads/${br}`)).object.sha;
    const baseTree = (await ghJson(env, `/repos/${repo}/git/commits/${head}`)).tree.sha;
    const tree = (await ghJson(env, `/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree: blobs.map(b => b.sha ? { path: b.path, mode: "100644", type: "blob", sha: b.sha } : { path: b.path, mode: "100644", type: "blob", content: b.content }) }) })).sha;
    const commit = (await ghJson(env, `/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree, parents: [head] }) })).sha;
    try { await ghJson(env, `/repos/${repo}/git/refs/heads/${br}`, { method: "PATCH", body: JSON.stringify({ sha: commit, force: false }) }); return commit; }
    catch (e) { if (!(e.status === 422 || e.status === 409) || i === 2) throw e; }
  }
}
async function comment(env, body) { const n = Number(env.WAKE_PR || 0); if (!n) return false; const r = await gh(env, `/repos/${env.GH_REPO}/issues/${n}/comments`, { method: "POST", body: JSON.stringify({ body }) }); return r.ok; }

// ---------- store ----------
const PUBLIC_FIELDS = ["productName","option","qty","price","orderDate","deliveredAt","productUrl","category","isTrial","trialInvitedAt","notes","status","photos","postedAt","helpfulCount","requestedAt","lastError"];
async function loadIndex(env) {
  const idx = await getJson(env, "index.json");
  if (idx && idx.data && idx.data.items) return idx.data;
  return rebuildIndex(env);
}
async function rebuildIndex(env) {
  const files = (await listDir(env, "items")).filter(f => f.name.endsWith(".json"));
  const items = {};
  for (const f of files) { const j = await getJson(env, f.path); if (j && j.data && j.data.id) items[j.data.id] = j.data; }
  const data = { updatedAt: nowIso(), items };
  try { await mutateJson(env, "index.json", () => data, "server: index 재생성"); } catch (e) { /* 읽기는 계속 */ }
  return data;
}
async function getItem(env, id) { const j = await getJson(env, "items/" + id + ".json"); return j ? j.data : null; }
async function saveItem(env, item, message) {
  item.updatedAt = nowIso();
  await mutateJson(env, "items/" + item.id + ".json", () => item, message);
  await mutateJson(env, "index.json", idx => { const d = idx && idx.items ? idx : { items: {} }; d.items[item.id] = item; d.updatedAt = nowIso(); return d; }, message + " (index)");
  return item;
}
function baseItem(o, account) {
  const now = nowIso();
  return Object.assign({ id: newId(), account, source: "coupang", status: "collected", photos: [], notes: {}, createdAt: now, updatedAt: now, qty: 1, option: "", deliveredAt: "", productUrl: "", category: "", isTrial: false, trialInvitedAt: "", price: null }, o);
}
function sanitizeCreate(b, account) {
  const name = String(b.productName || "").trim(); if (!name) throw httpErr(400, "상품명이 필요해요.");
  const t = String(b.trialInvitedAt || "").slice(0, 10);
  return baseItem({ productName: name, option: String(b.option || "").trim(), qty: Math.max(1, Number(b.qty) || 1), price: b.price != null && b.price !== "" ? Number(b.price) || null : null, orderDate: String(b.orderDate || kst()).slice(0, 10), deliveredAt: String(b.deliveredAt || "").slice(0, 10), productUrl: String(b.productUrl || "").trim(), category: CATS.includes(b.category) ? b.category : "", isTrial: !!t || !!b.isTrial, trialInvitedAt: t }, account);
}
function sanitizeNotes(n, prev) {
  const lines = v => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : String(v || "").split("\n").map(s => s.trim()).filter(Boolean);
  const out = Object.assign({}, prev || {});
  if (n.rating != null) out.rating = Math.min(5, Math.max(0, Number(n.rating) || 0));
  if (n.oneLine != null) out.oneLine = String(n.oneLine).trim();
  if (n.pros != null) out.pros = lines(n.pros);
  if (n.cons != null) out.cons = lines(n.cons);
  if (n.period != null) out.period = PERIODS.includes(n.period) ? n.period : String(n.period || "").trim();
  if (n.usage != null) out.usage = String(n.usage).trim();
  if (n.forWhom != null) out.forWhom = String(n.forWhom).trim();
  if (n.extra != null) out.extra = String(n.extra).trim();
  return out;
}
function readiness(it) {
  const n = it.notes || {}; const ph = (it.photos || []).length;
  return [{ ok: (n.rating || 0) > 0, t: "별점" }, { ok: !!n.oneLine, t: "한 줄 느낌" }, { ok: (n.pros || []).length > 0, t: "좋은 점" }, { ok: (n.cons || []).length > 0, t: "아쉬운 점(없으면 '없음')" }, { ok: !!n.period, t: "사용 기간" }, { ok: ph >= 1, t: "사진 1장 이상 (지금 " + ph + "장)" }];
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }
const isActive = it => !["posted", "skipped"].includes(it.status);

async function applyPatch(env, acct, id, patch) {
  const it = await getItem(env, id); if (!it) throw httpErr(404, "그 상품이 없어요: " + id);
  const p = patch || {};
  for (const k of ["productName","option","qty","price","orderDate","deliveredAt","productUrl","category","isTrial","trialInvitedAt","helpfulCount"]) if (p[k] !== undefined) it[k] = p[k];
  if (p.category !== undefined) it.category = CATS.includes(p.category) ? p.category : "";
  if (p.trialInvitedAt !== undefined) { it.trialInvitedAt = String(p.trialInvitedAt || "").slice(0, 10); it.isTrial = !!it.trialInvitedAt; }
  if (p.notes) it.notes = sanitizeNotes(p.notes, it.notes);
  if (Array.isArray(p.photoTags)) { it.photos = (it.photos || []).map((ph, i) => Object.assign({}, ph, { tag: TAGS.includes(p.photoTags[i]) ? p.photoTags[i] : (p.photoTags[i] === "" ? "" : ph.tag) })); }
  if (Array.isArray(p.photoOrder)) { const by = Object.fromEntries((it.photos || []).map(ph => [ph.file, ph])); const next = p.photoOrder.map(f => by[f]).filter(Boolean); if (next.length === (it.photos || []).length) it.photos = next; }
  let woke = false;
  if (p.status) {
    if (!["collected","ready","posted","skipped"].includes(p.status)) throw httpErr(400, "바꿀 수 없는 상태예요: " + p.status);
    if (p.status === "ready") {
      if (!isActive(it)) throw httpErr(400, "이미 게시됐거나 건너뛴 상품이에요.");
      const miss = readiness(it).filter(x => !x.ok).map(x => x.t); if (miss.length) throw httpErr(400, "아직 모자라요: " + miss.join(", "));
      it.status = "ready"; it.requestedAt = nowIso(); it.lastError = "";
    } else if (p.status === "posted") { it.status = "posted"; it.postedAt = nowIso(); }
    else if (p.status === "skipped") { it.status = "skipped"; }
    else if (p.status === "collected") { it.status = "collected"; }
  }
  await saveItem(env, it, `app(${acct}): ${p.status ? p.status + " " : ""}${it.id}`);
  if (p.status === "ready") woke = await comment(env, `ready ${it.id} ${it.productName} (${acct})`);
  return { item: it, woke };
}

// ---------- REST ----------
async function api(request, env, acct, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = request.method;
  try {
    if (parts[0] === "config" && m === "GET") return json({ name: env.APP_NAME || "리뷰 공방", wakePr: Number(env.WAKE_PR || 0) || null, account: acct, repo: env.GH_REPO });
    if (parts[0] === "items" && parts.length === 1 && m === "GET") { const idx = await loadIndex(env); const all = url.searchParams.get("all") === "1"; const items = Object.values(idx.items).filter(it => all || acct === "husband" || it.account === acct || !it.account).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); return json({ items, updatedAt: idx.updatedAt }); }
    if (parts[0] === "items" && parts.length === 1 && m === "POST") { const b = await request.json(); const it = sanitizeCreate(b, acct); await saveItem(env, it, `app(${acct}): 접수 ${it.productName}`); return json({ item: it }, 201); }
    if (parts[0] === "items" && parts.length === 2 && m === "GET") { const it = await getItem(env, parts[1]); if (!it) return json({ error: "없음" }, 404); return json({ item: it }); }
    if (parts[0] === "items" && parts.length === 2 && m === "PATCH") { const b = await request.json(); const r = await applyPatch(env, acct, parts[1], b); return json(r); }
    if (parts[0] === "items" && parts.length === 4 && parts[2] === "photos" && parts[3] === "batch" && m === "POST") {
      const it = await getItem(env, parts[1]); if (!it) return json({ error: "없음" }, 404);
      const fd = await request.formData(); const blobsIn = fd.getAll("photos").filter(f => f && typeof f.arrayBuffer === "function");
      if (!blobsIn.length) return json({ error: "사진이 없어요" }, 400); if (blobsIn.length > 10) return json({ error: "한 번에 10장까지" }, 400);
      let n = (it.photos || []).length; const files = []; const added = [];
      for (const f of blobsIn) { const buf = new Uint8Array(await f.arrayBuffer()); if (!buf.length) continue; if (buf.length > 6 * 1024 * 1024) return json({ error: "사진이 너무 커요(6MB 초과)" }, 413); n++; const file = `photos/${it.id}/${String(n).padStart(2, "0")}.jpg`; files.push({ path: file, base64: b64encode(buf) }); added.push({ file, tag: "" }); }
      it.photos = [...(it.photos || []), ...added]; it.updatedAt = nowIso();
      const idx = await loadIndex(env); idx.items[it.id] = it; idx.updatedAt = it.updatedAt;
      files.push({ path: `items/${it.id}.json`, content: JSON.stringify(it, null, 2) + "\n" });
      files.push({ path: "index.json", content: JSON.stringify(idx, null, 2) + "\n" });
      await commitFiles(env, files, `app(${acct}): 사진 ${added.length}장 ${it.id}`);
      return json({ item: it, files: added.map(a => a.file) });
    }
    if (parts[0] === "items" && parts.length === 3 && parts[2] === "photos" && m === "POST") {
      const it = await getItem(env, parts[1]); if (!it) return json({ error: "없음" }, 404);
      const buf = new Uint8Array(await request.arrayBuffer()); if (!buf.length) return json({ error: "빈 파일" }, 400); if (buf.length > 6 * 1024 * 1024) return json({ error: "사진이 너무 커요(6MB 초과)" }, 413);
      const n = (it.photos || []).length + 1; const file = `photos/${it.id}/${String(n).padStart(2, "0")}.jpg`;
      await putFile(env, file, b64encode(buf), `app(${acct}): 사진 ${it.id}`);
      const tag = url.searchParams.get("tag") || ""; it.photos = [...(it.photos || []), { file, tag: TAGS.includes(tag) ? tag : "" }];
      await saveItem(env, it, `app(${acct}): 사진 등록 ${it.id}`); return json({ item: it, file });
    }
    if (parts[0] === "items" && parts.length === 4 && parts[2] === "photos" && m === "DELETE") {
      const it = await getItem(env, parts[1]); if (!it) return json({ error: "없음" }, 404);
      const file = `photos/${it.id}/${parts[3]}`; it.photos = (it.photos || []).filter(p => p.file !== file);
      await saveItem(env, it, `app(${acct}): 사진 삭제 ${it.id}`); await deleteFile(env, file, `app(${acct}): 사진 삭제`); return json({ item: it });
    }
    if (parts[0] === "photo" && m === "GET") { const p = url.searchParams.get("path") || ""; if (!/^photos\/[A-Za-z0-9_\-]+\/\d{2}\.jpg$/.test(p)) return json({ error: "잘못된 경로" }, 400); const r = await getRaw(env, p); if (!r.ok) return json({ error: "없음" }, 404); return new Response(r.body, { status: 200, headers: Object.assign({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" }, CORS) }); }
    if (parts[0] === "reviews" && parts.length === 2 && m === "GET") { const j = await getJson(env, "reviews/" + parts[1] + ".json"); if (!j) return json({ error: "없음" }, 404); return json({ review: j.data }); }
    if (parts[0] === "rules" && m === "GET") { const f = await getFile(env, "config/style_guide.md"); return json({ text: f ? f.text : "", sha: f ? f.sha : null }); }
    if (parts[0] === "rules" && m === "PUT") { const b = await request.json(); const f = await getFile(env, "config/style_guide.md"); const sha = await putFile(env, "config/style_guide.md", b64encodeText(String(b.text || "")), `app(${acct}): 작성 규칙 수정`, f ? f.sha : undefined); return json({ sha }); }
    if (parts[0] === "reindex" && m === "POST") { const d = await rebuildIndex(env); return json({ count: Object.keys(d.items).length }); }
    return json({ error: "없는 주소" }, 404);
  } catch (e) { return json({ error: e.message || String(e) }, e.status || 500); }
}

// ---------- MCP (Streamable HTTP, stateless) ----------
const TOOLS = [
  { name: "list_items", description: "리뷰 공방에 접수된 상품 목록. status로 거를 수 있음(collected=사진·메모 필요, ready=작성 대기, drafting=작성 중, drafted=리뷰 완성, mismatch=사진 확인 필요, posted=게시됨). 기본은 진행 중인 것만.", inputSchema: { type: "object", properties: { status: { type: "string" }, all: { type: "boolean", description: "게시·건너뜀 포함 전체" } } } },
  { name: "get_item", description: "상품 하나의 상세: 주문 정보, 사진 수와 종류, 메모, 상태, 리뷰가 있으면 요약.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_item", description: "쿠팡에서 산 상품을 새로 접수. 상품명은 쿠팡 주문목록 표기 그대로. 체험단이면 trialInvitedAt(초대일 YYYY-MM-DD).", inputSchema: { type: "object", properties: { productName: { type: "string" }, option: { type: "string" }, qty: { type: "number" }, orderDate: { type: "string", description: "YYYY-MM-DD" }, deliveredAt: { type: "string" }, category: { type: "string", enum: CATS }, trialInvitedAt: { type: "string" } }, required: ["productName"] } },
  { name: "update_notes", description: "경험 메모 저장. 사용자가 말한 그대로 적을 것(지어내지 말 것). rating 1~5, oneLine 한 줄 느낌, pros/cons 배열, period(당일|2~3일|1주|2주|1개월|3개월 이상), usage 어떻게·어디서, forWhom 추천 대상, extra 추가 정보(의류 키·몸무게·사이즈, 식품 조리법·양, 가전 소음·설치 등).", inputSchema: { type: "object", properties: { id: { type: "string" }, rating: { type: "number" }, oneLine: { type: "string" }, pros: { type: "array", items: { type: "string" } }, cons: { type: "array", items: { type: "string" } }, period: { type: "string" }, usage: { type: "string" }, forWhom: { type: "string" }, extra: { type: "string" }, category: { type: "string", enum: CATS } }, required: ["id"] } },
  { name: "photo_link", description: "사진은 이 도구로 받은 링크를 사용자가 폰에서 열어 올려야 함(카메라·앨범). 사진 4~7장 권장: 전체 실물, 손·자와 크기 비교, 라벨·디테일, 사용 장면, 결과.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "request_review", description: "메모와 사진이 준비된 상품의 리뷰 작성을 요청. 조건(별점·한 줄·좋은 점·아쉬운 점·기간·사진 1장)이 모자라면 무엇이 빠졌는지 알려줌. 요청되면 보통 1~5분 안에 리뷰가 완성됨.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "get_review", description: "완성된 리뷰 본문(쿠팡에 그대로 붙여 넣는 완성본), 별점, 사진 순서와 캡션, 품질 점수, 보강 질문. 사진 검증에서 반려됐으면 그 이유.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "mark_posted", description: "쿠팡에 리뷰를 등록했다고 표시. 나중에 '도움이 돼요' 수를 helpfulCount로 기록할 수 있음.", inputSchema: { type: "object", properties: { id: { type: "string" }, helpfulCount: { type: "number" } }, required: ["id"] } },
  { name: "skip_item", description: "이 상품은 리뷰를 쓰지 않기로 하고 건너뜀 표시.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "get_rules", description: "엔진이 리뷰를 쓸 때 따르는 작성 규칙 전문(읽기 전용).", inputSchema: { type: "object", properties: {} } },
];
function fmtItem(it, rv) {
  const n = it.notes || {}; const ph = it.photos || [];
  const L = [`[${it.id}] ${it.productName}${it.option ? " / " + it.option : ""} · ${STATUS[it.status] || it.status}`,
    `주문 ${it.orderDate || "-"}${it.deliveredAt ? " · 배송 " + it.deliveredAt : ""} · 수량 ${it.qty || 1} · ${it.category || "카테고리 미정"}${it.isTrial ? " · 체험단(리뷰 마감 " + (it.trialInvitedAt ? addDays(it.trialInvitedAt, 14) : "?") + ")" : ""}`,
    `사진 ${ph.length}장${ph.length ? " (" + ph.map(p => p.tag || "미지정").join(", ") + ")" : ""}`,
    `메모: 별점 ${n.rating || "-"} · 한 줄 "${n.oneLine || ""}" · 좋은 점 ${(n.pros || []).join(" / ") || "-"} · 아쉬운 점 ${(n.cons || []).join(" / ") || "-"} · 기간 ${n.period || "-"} · 용도 ${n.usage || "-"} · 추천 ${n.forWhom || "-"}${n.extra ? " · 추가 " + n.extra : ""}`];
  const miss = readiness(it).filter(x => !x.ok).map(x => x.t); if (isActive(it) && miss.length) L.push("요청 전 필요: " + miss.join(", "));
  if (it.lastError) L.push("최근 오류: " + it.lastError);
  if (rv && rv.draft) L.push(`리뷰 완성 ${rv.draft.chars || ""}자 · 점수 ${rv.draft.score && rv.draft.score.total != null ? rv.draft.score.total : "-"} (get_review로 본문 보기)`);
  if (rv && !rv.draft && rv.photoCheck) L.push("사진 검증 반려: " + (rv.photoCheck.summary || ""));
  return L.join("\n");
}
async function callTool(env, acct, key, name, a) {
  a = a || {};
  const appLink = (id) => (env.APP_URL || "") + "#s=" + encodeURIComponent(new URL(env.SELF_URL || "https://example.invalid").origin) + "&k=" + encodeURIComponent(key) + (id ? "&i=" + encodeURIComponent(id) : "");
  switch (name) {
    case "list_items": {
      const idx = await loadIndex(env); let items = Object.values(idx.items).filter(it => acct === "husband" || it.account === acct || !it.account);
      if (a.status) items = items.filter(it => it.status === a.status); else if (!a.all) items = items.filter(isActive);
      items.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
      if (!items.length) return "해당하는 상품이 없어요." + (a.status ? "" : " create_item으로 접수할 수 있어요.");
      return items.map(it => `[${it.id}] ${it.productName}${it.option ? " / " + it.option : ""} — ${STATUS[it.status] || it.status} · 사진 ${(it.photos || []).length}장 · 주문 ${it.orderDate || "-"}${it.isTrial && it.trialInvitedAt ? " · 체험단 D-" + (14 - (daysSince(it.trialInvitedAt) || 0)) : ""}`).join("\n");
    }
    case "get_item": { const it = await getItem(env, String(a.id || "")); if (!it) return "그 id의 상품이 없어요."; const rv = ["drafted","mismatch","posted"].includes(it.status) ? (await getJson(env, "reviews/" + it.id + ".json"))?.data : null; return fmtItem(it, rv); }
    case "create_item": { const it = sanitizeCreate(a, acct); await saveItem(env, it, `pickle(${acct}): 접수 ${it.productName}`); return `접수했어요: [${it.id}] ${it.productName}\n다음: 사진은 이 링크에서 올려 주세요 → ${appLink(it.id)}\n그리고 별점·한 줄 느낌·좋은 점·아쉬운 점·사용 기간을 말해 주시면 update_notes로 적을게요.`; }
    case "update_notes": { const patch = { notes: {} }; for (const k of ["rating","oneLine","pros","cons","period","usage","forWhom","extra"]) if (a[k] !== undefined) patch.notes[k] = a[k]; if (a.category) patch.category = a.category; const r = await applyPatch(env, acct, String(a.id || ""), patch); const miss = readiness(r.item).filter(x => !x.ok).map(x => x.t); return "메모를 저장했어요.\n" + (miss.length ? "요청 전 필요: " + miss.join(", ") : "이제 request_review로 리뷰를 요청할 수 있어요."); }
    case "photo_link": { const it = await getItem(env, String(a.id || "")); if (!it) return "그 id의 상품이 없어요."; return `사진 올리는 링크(폰에서 열기): ${appLink(it.id)}\n지금 ${(it.photos || []).length}장. 전체 실물 · 크기 비교 · 라벨/디테일 · 사용 장면 · 결과 순으로 4~7장이면 좋아요.`; }
    case "request_review": { const r = await applyPatch(env, acct, String(a.id || ""), { status: "ready" }); return `리뷰 작성을 요청했어요: [${r.item.id}] ${r.item.productName}\n${r.woke ? "엔진을 깨웠어요. 보통 1~5분 뒤 get_review로 확인하세요." : "예약 엔진이 다음 실행(최대 3시간)에 써요. 나중에 get_review로 확인하세요."}`; }
    case "get_review": {
      const it = await getItem(env, String(a.id || "")); if (!it) return "그 id의 상품이 없어요.";
      const rv = (await getJson(env, "reviews/" + it.id + ".json"))?.data;
      if (it.status === "ready" || it.status === "drafting") return `아직 ${STATUS[it.status]}이에요. 잠시 뒤 다시 확인해 주세요.`;
      if (!rv) return `아직 리뷰가 없어요(상태: ${STATUS[it.status] || it.status}). 메모와 사진을 채우고 request_review로 요청하세요.`;
      if (!rv.draft) { const q = (rv.photoCheckQuestions || []).map(s => "- " + s).join("\n"); const per = ((rv.photoCheck && rv.photoCheck.photos) || []).map(p => `- ${p.file.split("/").pop()}: ${p.verdict}${(p.flags || []).length ? " (" + p.flags.join(",") + ")" : ""} ${p.note || ""}`).join("\n"); return `사진 검증에서 반려됐어요: ${rv.photoCheck && rv.photoCheck.summary || ""}\n${q}\n사진별:\n${per}\n맞는 사진으로 바꾼 뒤(${appLink(it.id)}) request_review를 다시 하세요. 사진이 정말 맞다면 extra에 "사진 확인함: 이유"를 적고 다시 요청하세요.`; }
      const d = rv.draft; const plan = (d.photoPlan || []).slice().sort((x, y) => (x.order || 0) - (y.order || 0)).map((p, i) => `${i + 1}. ${p.file ? p.file.split("/").pop() : ""} ${p.caption || ""}`).join("\n");
      return [`완성된 리뷰 — 별점 ${d.rating || it.notes?.rating || "-"}점 · ${d.chars || String(d.body || "").length}자 · 점수 ${d.score && d.score.total != null ? d.score.total : "-"}${rv.model ? " · " + rv.model : ""}`,
        "----- 아래를 쿠팡 리뷰 창에 그대로 붙여 넣으세요 -----", d.body || "", "-----",
        plan ? "사진 순서:\n" + plan : "", (d.questions || []).length ? "더 채우면 좋은 것: " + d.questions.join(" / ") : "", (d.warnings || []).length ? "참고: " + d.warnings.join(" / ") : "", "등록했으면 mark_posted로 표시해 주세요."].filter(Boolean).join("\n");
    }
    case "mark_posted": { const patch = { status: "posted" }; if (a.helpfulCount != null) patch.helpfulCount = Number(a.helpfulCount) || 0; const r = await applyPatch(env, acct, String(a.id || ""), patch); return `게시 완료로 표시했어요: [${r.item.id}] ${r.item.productName}`; }
    case "skip_item": { const r = await applyPatch(env, acct, String(a.id || ""), { status: "skipped" }); return `건너뜀으로 표시했어요: [${r.item.id}]`; }
    case "get_rules": { const f = await getFile(env, "config/style_guide.md"); return f ? f.text.slice(0, 12000) : "규칙 문서가 아직 없어요."; }
    default: throw httpErr(404, "없는 도구: " + name);
  }
}
async function mcp(request, env, acct, key) {
  if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405, headers: Object.assign({ "Allow": "POST" }, CORS) });
  if (request.method !== "POST") return text("method", 405);
  env = Object.assign({}, env, { SELF_URL: new URL(request.url).origin });
  let body; try { body = await request.json(); } catch (e) { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== "2.0") continue;
    if (m.id === undefined || m.id === null) continue; // notification
    out.push(await rpc(env, acct, key, m));
  }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  const headers = { "Mcp-Session-Id": "stateless" };
  return json(Array.isArray(body) ? out : out[0], 200, headers);
}
async function rpc(env, acct, key, m) {
  const id = m.id; const p = m.params || {};
  try {
    switch (m.method) {
      case "initialize": return { jsonrpc: "2.0", id, result: { protocolVersion: p.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "review-lab", version: "1.0.0" }, instructions: `리뷰 공방(${acct === "wife" ? "아내" : "남편"} 계정) 커넥터. 흐름: create_item(배송 완료 상품 접수) → 사진은 photo_link의 링크에서 올림 → update_notes(사용자가 말한 그대로) → request_review → 1~5분 뒤 get_review(쿠팡에 그대로 붙여 넣을 완성본·별점·사진 순서) → 쿠팡 리뷰 작성에 별점·본문·사진을 넣고 등록 → mark_posted. 리뷰 본문은 서버 엔진이 쓰며 고치지 않고 그대로 올린다. 메모에 없는 경험은 지어내 적지 않는다. 사용자의 프로젝트 지침(피클 지시서)이 있으면 그것을 우선한다.` } };
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": { const name = p.name; if (!TOOLS.find(t => t.name === name)) return { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool " + name } }; try { const txt = await callTool(env, acct, key, name, p.arguments || {}); return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: txt }], isError: false } }; } catch (e) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "실패: " + (e.message || String(e)) }], isError: true } }; } }
      case "resources/list": return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "resources/templates/list": return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
      case "prompts/list": return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + m.method } };
    }
  } catch (e) { return { jsonrpc: "2.0", id, error: { code: -32000, message: e.message || String(e) } }; }
}
