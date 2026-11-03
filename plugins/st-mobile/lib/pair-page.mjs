export const PAIR_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在配对…</title>
<style>body{font-family:system-ui,sans-serif;background:#14161a;color:#e6e8eb;padding:2rem;line-height:1.7}
code{background:#1b1e24;padding:2px 6px;border-radius:4px}</style></head>
<body><h2 id="title">正在配对…</h2><p id="detail"></p>
<script>
(function(){
  var title = document.getElementById('title');
  var detail = document.getElementById('detail');
  var hash = location.hash.replace(/^#/, '');
  var token = null;
  if (hash.indexOf('key=') === 0) {
    var parts = hash.slice(4).split('.');
    if (parts.length === 3) token = parts[2];
  } else {
    var params = new URLSearchParams(hash);
    token = params.get('token');
  }
  if (!token) { title.textContent = '配对链接无效'; detail.textContent = '缺少配对令牌，请让电脑端重新生成二维码。'; return; }
  fetch('/mobile-access/auth/native-pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, label: 'browser' })
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    title.textContent = '配对成功';
    detail.textContent = '正在进入酒馆…';
    location.replace('/');
  }).catch(function (error) {
    title.textContent = '配对失败';
    detail.textContent = String(error.message || error);
  });
})();
</script></body></html>`;
