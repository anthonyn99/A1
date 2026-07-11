// MV3 service worker. Opens tabs on request from the popup so the launch
// finishes even after the popup window closes.
//
// Message shape: { action: "openLinks", urls: ["https://…", ...] }

function normalize(url) {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== "openLinks") return;

  const urls = (Array.isArray(message.urls) ? message.urls : [])
    .map(normalize)
    .filter(Boolean);

  urls.forEach((url, i) => {
    chrome.tabs.create({ url, active: i === 0 });
  });

  sendResponse({ opened: urls.length });
  return true; // keep channel open for async sendResponse
});
