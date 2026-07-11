// MV3 service worker. Opens course tabs when asked by the popup.
//
// Storage shape:
//   courses = [{ name, links: [{ label, url }, ...] }, ...]

// Open a list of links as tabs. The first tab is focused; the rest load in the
// background simultaneously.
function openLinks(links) {
  links
    .filter((link) => link && link.url)
    .forEach((link, index) => {
      chrome.tabs.create({ url: link.url, active: index === 0 });
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  chrome.storage.sync.get({ courses: [] }, (data) => {
    const courses = Array.isArray(data.courses) ? data.courses : [];

    if (message.action === "openCourse") {
      const course = courses[message.index];
      const links = course && Array.isArray(course.links) ? course.links : [];
      openLinks(links);
      sendResponse({ opened: links.length });
    } else if (message.action === "openAll") {
      const allLinks = courses.flatMap((c) =>
        Array.isArray(c.links) ? c.links : []
      );
      openLinks(allLinks);
      sendResponse({ opened: allLinks.length });
    }
  });

  // Keep the message channel open for the async sendResponse.
  return true;
});
