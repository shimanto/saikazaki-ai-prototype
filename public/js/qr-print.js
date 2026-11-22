// 拠点 QR コードの印刷ページ
(async () => {
  const sheet = document.getElementById('sheet');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  try {
    const { spots } = await (await fetch('/api/spots')).json();
    sheet.innerHTML = '';
    for (const s of spots) {
      const qr = window.qrcode(0, 'M');
      qr.addData(s.qr);
      qr.make();
      const card = document.createElement('div');
      card.className = 'qr-card';
      card.dataset.spot = s.id;
      const pt = s.kind === 'departure' ? '50pt ＋ 滞在ポイント' : `${s.points}pt`;
      card.innerHTML = `
        <div class="small muted">雑賀崎 滞在ポイント</div>
        <div class="name">${esc(s.name)}</div>
        <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <div class="pt">${esc(pt)}</div>
        <div class="small">${esc(s.description)}</div>
        <div class="url">${esc(s.qr)}</div>`;
      sheet.appendChild(card);
    }
  } catch (e) {
    console.error(e);
    sheet.innerHTML = '<p class="notice">拠点の読み込みに失敗しました。再読み込みしてください。</p>';
  }
})();
