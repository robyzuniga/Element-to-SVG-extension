// Service worker: injects the picker on demand and fetches cross-origin
// resources (images) so they can be embedded into the exported SVG.

const CONTENT_SCRIPTS = ['src/content/serializer.js', 'src/content/picker.js'];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CONTENT_SCRIPTS,
    });
  } catch (err) {
    // chrome://, the Web Store and other protected pages can't be scripted.
    console.warn('Element to SVG: cannot run on this page.', err);
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d93025' });
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'el2svg:fetch-data-url') return false;
  fetchAsDataUrl(msg.url).then(
    (dataUrl) => sendResponse({ dataUrl }),
    (err) => sendResponse({ error: String(err?.message || err) }),
  );
  return true; // keep the channel open for the async response
});

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const type = blob.type || res.headers.get('content-type') || 'application/octet-stream';
  return `data:${type};base64,${btoa(binary)}`;
}
