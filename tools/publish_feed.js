// publish_feed.js — copy a built post page (OUT_DIR: index.html + img/ + post_plain.txt) to the login-free hand-off feed.
// GitHub mode (default): files are written to a public GitHub Pages repo through the gh CLI (Contents API; auth injected by the session proxy).
//   node publish_feed.js --repo OWNER/REPO --token FEEDTOKEN --post OUT_DIR --meta meta.json [--postjson post.json] [--prune-days 3]
// Local mode (no GitHub; for tests): node publish_feed.js --local FEED_DIR --token FEEDTOKEN --post OUT_DIR --meta meta.json
// meta.json: {"id","date","theme","themeLabel","naverCategory","index","slot","title","keyword","aiImages","category","naverTopic","hashtags":[],"dashboardPostId"}
// Layout in the repo:  robots.txt (Disallow all) · f/<token>/index.html (today list) · f/<token>/posts.json (registry) · f/<token>/<date>/<id>/index.html, img/*, post_plain.txt, post.json
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const REPO = opt('repo'), LOCAL = opt('local'), TOKEN = opt('token'), POST = opt('post'), METAP = opt('meta'), POSTJSON = opt('postjson'), PRUNE = +opt('prune-days', 3);
if ((!REPO && !LOCAL) || !TOKEN || !POST || !METAP) { console.error('usage: see header'); process.exit(2); }
const meta = JSON.parse(fs.readFileSync(METAP, 'utf8'));
const base = `f/${TOKEN}`; const postDir = `${base}/${meta.date}/${meta.id}`;
const CAT = { money: '금융', digital: 'IT', travel: '여행', routine: '루틴' }; // 네이버 블로그 카테고리 이름(테마별 기본값)
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- storage backends ----------
function gh(argsArr, input) { const a = ['api', ...argsArr]; if (input !== undefined) { const tmp = path.join(require('os').tmpdir(), 'ghin-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json'); fs.writeFileSync(tmp, JSON.stringify(input)); a.push('--input', tmp); try { return execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } finally { fs.unlinkSync(tmp); } } return execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
const backend = LOCAL ? {
  read(p) { const f = path.join(LOCAL, p); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
  write(p, buf) { const f = path.join(LOCAL, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); },
  list(p) { const f = path.join(LOCAL, p); if (!fs.existsSync(f)) return []; const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else out.push(path.relative(LOCAL, fp)); } })(f); return out; },
  remove(p) { const f = path.join(LOCAL, p); if (fs.existsSync(f)) fs.unlinkSync(f); },
} : {
  sha(p) { try { return JSON.parse(gh([`/repos/${REPO}/contents/${p}?ref=main`])).sha || null; } catch (e) { return null; } },
  read(p) { try { const j = JSON.parse(gh([`/repos/${REPO}/contents/${p}?ref=main`])); return Buffer.from(j.content || '', 'base64'); } catch (e) { return null; } },
  write(p, buf, msg) { for (let i = 0; i < 4; i++) { const sha = this.sha(p); const body = { message: msg || `feed: ${p}`, content: Buffer.from(buf).toString('base64'), branch: 'main' }; if (sha) body.sha = sha; try { gh(['-X', 'PUT', `/repos/${REPO}/contents/${p}`], body); return; } catch (e) { if (i === 3) throw e; execFileSync('sleep', [String(2 + i * 2)]); } } },
  list(p) { const out = []; const walk = (d) => { let arr; try { arr = JSON.parse(gh([`/repos/${REPO}/contents/${d}?ref=main`])); } catch (e) { return; } if (!Array.isArray(arr)) return; for (const e of arr) { if (e.type === 'dir') walk(e.path); else out.push(e.path); } }; walk(p); return out; },
  remove(p) { const sha = this.sha(p); if (!sha) return; gh(['-X', 'DELETE', `/repos/${REPO}/contents/${p}`], { message: `feed: prune ${p}`, sha, branch: 'main' }); },
};

// ---------- 1) copy the post package ----------
const files = ['index.html', 'post_plain.txt'].filter(f => fs.existsSync(path.join(POST, f)));
for (const f of files) backend.write(`${postDir}/${f}`, fs.readFileSync(path.join(POST, f)), `feed: ${meta.id} ${f}`);
if (POSTJSON && fs.existsSync(POSTJSON)) backend.write(`${postDir}/post.json`, fs.readFileSync(POSTJSON), `feed: ${meta.id} post.json`);
const imgDir = path.join(POST, 'img'); let imgCount = 0;
if (fs.existsSync(imgDir)) for (const f of fs.readdirSync(imgDir)) { backend.write(`${postDir}/img/${f}`, fs.readFileSync(path.join(imgDir, f)), `feed: ${meta.id} img`); imgCount++; }
console.log('copied', files.length + imgCount, 'files to', postDir);

// ---------- 2) registry ----------
let reg = []; const rb = backend.read(`${base}/posts.json`); if (rb) { try { reg = JSON.parse(rb.toString('utf8')); } catch (e) { reg = []; } }
reg = reg.filter(r => r.id !== meta.id);
reg.push({ id: meta.id, date: meta.date, theme: meta.theme, naverCategory: meta.naverCategory || CAT[meta.theme] || '', themeLabel: meta.themeLabel, index: meta.index, slot: meta.slot, title: meta.title, keyword: meta.keyword, aiImages: !!meta.aiImages, category: meta.category, naverTopic: meta.naverTopic, hashtags: meta.hashtags || [], path: `${meta.date}/${meta.id}/`, dashboardPostId: meta.dashboardPostId || meta.id, addedAt: new Date().toISOString() });
// prune old entries + files
const cutoff = new Date(Date.now() - PRUNE * 86400000).toISOString().slice(0, 10);
const old = reg.filter(r => r.date < cutoff); reg = reg.filter(r => r.date >= cutoff);
for (const r of old) { try { for (const p of backend.list(`${base}/${r.path.replace(/\/$/, '')}`)) backend.remove(p); console.log('pruned', r.id); } catch (e) { console.log('prune failed', r.id, e.message.slice(0, 80)); } }
reg.sort((a, b) => b.date.localeCompare(a.date) || String(a.slot || '').localeCompare(String(b.slot || '')));
backend.write(`${base}/posts.json`, Buffer.from(JSON.stringify(reg, null, 1)), 'feed: registry');

// ---------- 3) static index (today first) ----------
const days = [...new Set(reg.map(r => r.date))];
const row = (r) => `<li class="p"><div class="m"><span class="t ${esc(r.theme)}">${esc(r.themeLabel || r.theme)}</span><span class="t" style="background:#1f6f5f;color:#fff">📁 ${esc(r.naverCategory || CAT[r.theme] || '')}</span><b>${esc(r.slot || '')}</b>${r.aiImages ? '<span class="ai">AI 이미지 포함 · AI 활용 표시 켜기</span>' : ''}</div><a class="title" href="./${esc(r.path)}">${esc(r.title)}</a><div class="m">네이버 카테고리 ${esc(r.naverCategory || CAT[r.theme] || '')} · 테마 ${esc(r.category || '')} · 주제 분류 ${esc(r.naverTopic || '')} · 글 ID ${esc(r.id)}</div></li>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>오늘의 글 피드</title>
<style>body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:860px;margin:0 auto;padding:20px 16px;color:#172127;background:#f6f7f3;line-height:1.55}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px;color:#4a5a52}ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}.p{background:#fff;border:1px solid #dfe4dd;border-radius:12px;padding:12px 14px}.m{font-size:13px;color:#60706a;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.m b{color:#172127}.t{display:inline-block;padding:1px 9px;border-radius:999px;color:#fff;font-size:12px;font-weight:600}.t.money{background:#14694f}.t.digital{background:#2e3fa3}.t.routine{background:#d9622b}.t.travel{background:#0e7490}.title{display:block;font-size:17px;font-weight:700;margin:6px 0;color:#1f4068;text-decoration:none}.ai{background:#fff3cd;color:#7a5a00;padding:1px 8px;border-radius:999px;font-size:12px}.note{font-size:13px;color:#60706a}</style></head><body>
<h1>오늘의 글 피드</h1><p class="note">발행 대행용 목록입니다. 각 글을 열어 '제목 복사 → 서식 복사 → 이미지 복사'로 네이버에 옮기고, 적힌 시각으로 예약 발행하세요. 갱신: ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
${days.map(d => `<h2>${esc(d)}${d === reg[0].date ? ' (최신)' : ''}</h2><ul>${reg.filter(r => r.date === d).map(row).join('')}</ul>`).join('')}
<p class="note" style="margin-top:28px">posts.json 에 같은 목록이 기계용으로 들어 있어요.</p></body></html>`;
backend.write(`${base}/index.html`, Buffer.from(html), 'feed: index');
console.log('FEED_DONE', meta.id, 'entries', reg.length);
