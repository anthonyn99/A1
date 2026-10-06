// LifeHub "Open all" bridge. A web page can't make a tab group, so LifeHub
// (lifehub.js) posts the request here and this content script relays it to the
// background, which already builds the named, coloured group (openLinksAsGroup).
// Same message shapes as the Vault extension's vault-bio-sync.js, so one
// LifeHub works with either extension.
(function () {
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.origin && e.origin.indexOf('https://anthonyn99.github.io') !== 0) return;
    var d = e.data;
    if (!d) return;

    if (d.source === 'tradehub-vault' && d.action === 'aiLaunchPing') {
      try {
        chrome.runtime.sendMessage({ action: 'aiLaunchCapability' }, function (resp) {
          var ok = !chrome.runtime.lastError && resp && resp.ok;
          window.postMessage({ source: 'vault-extension', action: 'aiLaunchPong', ok: !!ok }, e.origin || '*');
        });
      } catch (err) {}
      return;
    }

    if (d.source === 'vault-page' && d.action === 'openLinkGroup') {
      var urls = Array.isArray(d.urls) ? d.urls.filter(Boolean) : [];
      if (!urls.length) return;
      try {
        chrome.runtime.sendMessage(
          { action: 'openLinks', urls: urls, group: urls.length > 1, groupName: d.name || 'Links', groupColor: d.color || '' },
          function () { void chrome.runtime.lastError; }
        );
        window.postMessage({ source: 'vault-extension', action: 'openLinkGroupAck' }, e.origin || '*');
      } catch (err) {}
    }
  });
})();
