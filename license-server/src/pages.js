export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · IMALI Commander</title>
<style>
:root{--bg:#070b16;--panel:#0f1729;--line:#25324d;--text:#eaf1fb;--muted:#9eb0c9;--accent:#5eead4;--accent2:#22c55e;--gold:#fbbf24}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 70% -10%,#13405a 0,#0a1226 48%,var(--bg) 100%) fixed;color:var(--text);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:36px 18px 70px}
a{color:var(--accent)}
.eyebrow{color:var(--accent);font-weight:800;letter-spacing:.16em;font-size:12px;text-transform:uppercase}
h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.08;letter-spacing:-.035em;margin:8px 0 12px}
h2{margin:30px 0 10px}
.lead{color:var(--muted);font-size:1.08rem;max-width:640px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:22px}
.plan{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:8px}
.plan.best{border-color:var(--accent)}
.price{font-size:2.1rem;font-weight:900;letter-spacing:-.03em}
.price small{font-size:1rem;color:var(--muted);font-weight:600}
.plan ul{margin:6px 0 12px;padding-left:18px;color:var(--muted)}
.btn{display:inline-block;text-align:center;padding:13px 20px;border-radius:12px;font-weight:800;text-decoration:none;border:0;cursor:pointer;font-size:1rem;background:linear-gradient(120deg,var(--accent),var(--accent2));color:#03161a}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.plan .btn{margin-top:auto}
.key{font:700 clamp(1rem,3.6vw,1.45rem)/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;background:#030814;border:1px solid var(--gold);color:var(--gold);border-radius:14px;padding:18px;text-align:center;user-select:all;word-break:break-all}
pre{background:#030814;border:1px solid var(--line);border-radius:12px;padding:14px;overflow-x:auto;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.note{border-left:3px solid var(--gold);background:#1a160a;color:#f3e7c4;padding:12px 14px;border-radius:8px}
.muted{color:var(--muted)}
input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--line);background:#030814;color:var(--text);font:16px ui-monospace,Menlo,monospace;margin:8px 0 14px}
table{width:100%;border-collapse:collapse;margin-top:10px}
td,th{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function pricing(config) {
  const base = config.publicUrl;
  return layout('Pricing', `
<div class="eyebrow">IMALI Commander</div>
<h1>Safe file access for every AI assistant.</h1>
<p class="lead">The free edition gives Claude Desktop and other local assistants scoped access to one folder. Pro opens it up to ChatGPT and web assistants over HTTPS, with as many workspaces as you need.</p>
<div class="plans">
  <section class="plan">
    <h2 style="margin:0">Pro monthly</h2>
    <div class="price">$9<small> / month</small></div>
    <ul><li>Remote HTTPS access</li><li>Multiple workspaces</li><li>Priority email support</li><li>Use on up to ${config.maxActivations} machines</li></ul>
    <a class="btn" href="${esc(base)}/buy?plan=monthly">Get Pro monthly</a>
  </section>
  <section class="plan best">
    <h2 style="margin:0">Pro yearly</h2>
    <div class="price">$79<small> / year</small></div>
    <ul><li>Everything in monthly</li><li>Save 27% (about 3 months free)</li></ul>
    <a class="btn" href="${esc(base)}/buy?plan=yearly">Get Pro yearly</a>
  </section>
</div>
<h2>Free vs Pro</h2>
<table>
<tr><th></th><th>Free</th><th>Pro</th></tr>
<tr><td>All 10 tools, read-only mode, audit log</td><td>✔</td><td>✔</td></tr>
<tr><td>Claude Desktop and local clients</td><td>✔</td><td>✔</td></tr>
<tr><td>Remote HTTPS (ChatGPT, web assistants)</td><td></td><td>✔</td></tr>
<tr><td>Multiple workspaces</td><td></td><td>✔</td></tr>
</table>
<p class="muted">Start free: <code>npm install -g imali-commander</code>. Cancel Pro anytime. Already a customer? <a href="${esc(base)}/manage">Manage your subscription</a>.</p>`);
}

export function success(license, config) {
  return layout('Your license', `
<div class="eyebrow">Thank you</div>
<h1>You're on IMALI Commander Pro.</h1>
<p class="lead">This is your license key. <b>Save it somewhere safe</b> (a password manager is ideal). You'll need it on each machine.</p>
<div class="key">${esc(license.key)}</div>
<h2>Turn on Pro</h2>
<pre>npm install -g imali-commander      # if you haven't already
imali-commander init                # first time only
imali-commander activate ${esc(license.key)}
imali-commander service restart</pre>
<p class="muted">Works on up to ${config.maxActivations} machines at once. Moving machines? Run <code>imali-commander deactivate</code> on the old one first.</p>
<p class="note">Lost your key later? Email ${config.supportEmail ? `<a href="mailto:${esc(config.supportEmail)}">${esc(config.supportEmail)}</a>` : 'support'} from the address you paid with.</p>
<p><a class="btn ghost" href="${esc(config.publicUrl)}/manage">Manage subscription</a></p>`);
}

export function processing() {
  return layout('Payment processing', `
<div class="eyebrow">Almost there</div>
<h1>Your payment is still processing.</h1>
<p class="lead">This usually takes a few seconds. Refresh this page to see your license key.</p>`);
}

export function manage(config, error = '') {
  return layout('Manage subscription', `
<div class="eyebrow">IMALI Commander Pro</div>
<h1>Manage your subscription</h1>
<p class="lead">Enter your license key to update your card, see invoices, switch plans or cancel.</p>
${error ? `<p class="note">${esc(error)}</p>` : ''}
<form method="post" action="${esc(config.publicUrl)}/manage">
  <label for="key">License key</label>
  <input id="key" name="key" autocomplete="off" placeholder="IMALI-XXXXX-XXXXX-XXXXX-XXXXX" required maxlength="64">
  <button class="btn" type="submit">Open billing portal</button>
</form>`);
}

export function message(title, text) {
  return layout(title, `<div class="eyebrow">IMALI Commander</div><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>`);
}
