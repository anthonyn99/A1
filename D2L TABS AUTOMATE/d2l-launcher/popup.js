const courseList = document.getElementById("courseList");
const openAllBtn = document.getElementById("openAll");
const gearBtn = document.getElementById("gear");

// Open the options page when the gear icon is clicked.
gearBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Render one card per course, each with its own "Open" button.
function render(courses) {
  courseList.innerHTML = "";

  if (!courses || courses.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = "No courses added yet. Click ⚙ to add your D2L URLs.";
    courseList.appendChild(placeholder);
    openAllBtn.disabled = true;
    return;
  }

  openAllBtn.disabled = false;

  courses.forEach((course, index) => {
    const links = course.links || [];

    const card = document.createElement("div");
    card.className = "course-card";

    const meta = document.createElement("div");
    meta.className = "course-meta";

    const name = document.createElement("div");
    name.className = "course-name";
    name.textContent = course.name;
    name.title = course.name;

    const count = document.createElement("div");
    count.className = "course-count";
    count.textContent = links.length === 1 ? "1 tab" : `${links.length} tabs`;

    meta.appendChild(name);
    meta.appendChild(count);

    const openBtn = document.createElement("button");
    openBtn.className = "open-one";
    openBtn.textContent = "Open";
    openBtn.disabled = links.length === 0;

    // Open just this course's tabs. The whole card is clickable; the button is
    // a visual affordance that triggers the same action.
    const openCourse = () => {
      if (links.length === 0) return;
      chrome.runtime.sendMessage({ action: "openCourse", index }, () => {
        window.close();
      });
    };
    card.addEventListener("click", openCourse);

    card.appendChild(meta);
    card.appendChild(openBtn);
    courseList.appendChild(card);
  });
}

// Load saved courses from synced storage on popup open.
chrome.storage.sync.get({ courses: [] }, (data) => {
  render(data.courses);
});

// Open every course's tabs at once.
openAllBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openAll" }, () => {
    window.close();
  });
});
