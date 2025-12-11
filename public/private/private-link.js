// private-link.js
const form = document.querySelector('#genForm');
const modalBackdrop = document.querySelector('#modalBackdrop');
const modalLinkText = document.querySelector('#modalLinkText');
const copyBtn = document.querySelector('#copyBtn');
const openBtn = document.querySelector('#openBtn');
const closeBtn = document.querySelector('#closeBtn');

function hostOnly() {
  // p.ej. "127.0.0.1:3000" o "midominio.com"
  return window.location.host.replace(/\/+$/, '');
}
function originSafe() {
  // p.ej. "http://127.0.0.1:3000"
  return window.location.origin.replace(/\/+$/, '');
}
function showModal() { modalBackdrop.style.display = 'flex'; }
function hideModal() { modalBackdrop.style.display = 'none'; }

function looksLikeSlug(s) {
  return /^[a-zA-Z0-9_-]{3,}$/.test(s);
}
function looksLikeHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

async function upsertLink({ slug, displayName, targetUrl }) {
  // Reutiliza el endpoint existente /admin/new
  const formData = new URLSearchParams();
  formData.set('slug', slug);
  formData.set('display_name', displayName);
  formData.set('field', 'instagram');       // fijo
  formData.set('target_url', targetUrl);

  const res = await fetch('/admin/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formData.toString()
  });

  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`Fallo guardando (${res.status}): ${text || 'sin detalle'}`);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const slug = (document.querySelector('#slug')?.value || '').trim();
  const displayName = (document.querySelector('#displayName')?.value || '').trim();
  const targetUrl = (document.querySelector('#targetUrl')?.value || '').trim();

  if (!looksLikeSlug(slug)) {
    alert('Slug inválido. Usa alfanumérico, "_" o "-", mínimo 3 caracteres.');
    return;
  }
  if (!displayName) {
    alert('Ingresa el nombre a mostrar.');
    return;
  }
  if (!looksLikeHttpUrl(targetUrl)) {
    alert('El link de destino debe comenzar con http:// o https://');
    return;
  }

  try {
    // Guarda en tu backend (crea/actualiza la fila y public_url)
    await upsertLink({ slug, displayName, targetUrl });

    // Muestra solo "dominio/searchEngine/slug" (sin protocolo)
    const host = hostOnly();
    const pathPretty = `${host}/searchEngine/${slug}`;
    modalLinkText.textContent = pathPretty;

    // Y habilita "Abrir" con el origin completo (con protocolo)
    const full = `${originSafe()}/searchEngine/${slug}`;
    openBtn.href = full;

    showModal();
  } catch (err) {
    console.error(err);
    alert(err.message || 'No se pudo guardar el link.');
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(modalLinkText.textContent);
    copyBtn.textContent = 'Copiado';
    setTimeout(() => (copyBtn.textContent = 'Copiar'), 1600);
  } catch {
    // Fallback copiar seleccionando
    const range = document.createRange();
    range.selectNodeContents(modalLinkText);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    try { document.execCommand('copy'); } catch {}
    sel.removeAllRanges();
  }
});

closeBtn.addEventListener('click', hideModal);
modalBackdrop.addEventListener('click', (e) => {
  // cierra si hacen click fuera del modal
  if (e.target === modalBackdrop) hideModal();
});
