const courseNameInput = document.getElementById("courseName");
const courseError = document.getElementById("courseError");
const addCourseBtn = document.getElementById("addCourseBtn");
const listEl = document.getElementById("list");
const saveBtn = document.getElementById("saveBtn");
const savedMsg = document.getElementById("savedMsg");

// Default courses, seeded the first time the extension runs (empty storage).
const DEFAULT_COURSES = [
  {
    name: "Contemporary Economic Issues",
    links: [
      { label: "Quizzes", url: "https://kennesaw.view.usg.edu/d2l/lms/quizzing/user/quizzes_list.d2l?ou=3993309" },
      { label: "Course Home", url: "https://kennesaw.view.usg.edu/d2l/home/3993309" }
    ]
  },
  {
    name: "Human Communication",
    links: [
      { label: "Content", url: "https://kennesaw.view.usg.edu/d2l/le/content/3993226/Home" },
      { label: "Course Home", url: "https://kennesaw.view.usg.edu/d2l/home/3993226" }
    ]
  },
  {
    name: "Calculus II",
    links: [
      { label: "Course Home", url: "https://kennesaw.view.usg.edu/d2l/home/3992959" },
      { label: "Achieve", url: "https://kennesaw.view.usg.edu/d2l/le/content/3992959/viewContent/61886958/View" }
    ]
  },
  {
    name: "PPS II Lab",
    links: [
      { label: "Gradescope", url: "https://www.gradescope.com/courses/1323299" },
      { label: "Course Home", url: "https://kennesaw.view.usg.edu/d2l/home/3992757" }
    ]
  },
  {
    name: "PPS II",
    links: [
      { label: "Quizzes", url: "https://kennesaw.view.usg.edu/d2l/lms/quizzing/user/quizzes_list.d2l?ou=3992745" },
      { label: "Course Home", url: "https://kennesaw.view.usg.edu/d2l/home/3992745" }
    ]
  }
];

// In-memory working copy. Persisted only on "Save Changes".
let courses = [];

// Load saved courses, or seed defaults on a fresh install.
chrome.storage.sync.get({ courses: null }, (data) => {
  if (Array.isArray(data.courses)) {
    courses = data.courses;
  } else {
    courses = DEFAULT_COURSES;
  }
  render();
});

function render() {
  listEl.innerHTML = "";

  if (courses.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No courses yet. Add one above.";
    listEl.appendChild(empty);
    return;
  }

  courses.forEach((course, ci) => {
    const links = course.links || (course.links = []);

    const block = document.createElement("div");
    block.className = "course-block";

    // ---- Course header: title + reorder/delete ----
    const head = document.createElement("div");
    head.className = "course-head";

    const title = document.createElement("div");
    title.className = "course-title";
    title.textContent = course.name;
    title.title = course.name;

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const upBtn = makeIconBtn("↑", "Move course up", ci === 0, () => moveCourse(ci, -1));
    const downBtn = makeIconBtn("↓", "Move course down", ci === courses.length - 1, () => moveCourse(ci, 1));
    const delBtn = makeIconBtn("🗑", "Delete course", false, () => removeCourse(ci));
    delBtn.classList.add("delete");

    actions.append(upBtn, downBtn, delBtn);
    head.append(title, actions);
    block.appendChild(head);

    // ---- Existing links ----
    links.forEach((link, li) => {
      const row = document.createElement("div");
      row.className = "link-row";

      const info = document.createElement("div");
      info.className = "link-info";

      const label = document.createElement("div");
      label.className = "link-label";
      label.textContent = link.label || "(no label)";

      const url = document.createElement("div");
      url.className = "link-url";
      url.textContent = link.url;
      url.title = link.url;

      info.append(label, url);

      const linkActions = document.createElement("div");
      linkActions.className = "row-actions";

      const lUp = makeIconBtn("↑", "Move link up", li === 0, () => moveLink(ci, li, -1));
      const lDown = makeIconBtn("↓", "Move link down", li === links.length - 1, () => moveLink(ci, li, 1));
      const lDel = makeIconBtn("🗑", "Delete link", false, () => removeLink(ci, li));
      lDel.classList.add("delete");

      linkActions.append(lUp, lDown, lDel);
      row.append(info, linkActions);
      block.appendChild(row);
    });

    // ---- Add-link form for this course ----
    const addRow = document.createElement("div");
    addRow.className = "add-link";

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = "Link label (e.g. Quizzes)";

    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";

    const addLinkBtn = document.createElement("button");
    addLinkBtn.textContent = "Add Link";

    const linkErr = document.createElement("div");
    linkErr.className = "link-error";

    const doAdd = () => addLink(ci, labelInput, urlInput, linkErr);
    addLinkBtn.addEventListener("click", doAdd);
    [labelInput, urlInput].forEach((inp) =>
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
      })
    );

    addRow.append(labelInput, urlInput, addLinkBtn);
    block.appendChild(addRow);
    block.appendChild(linkErr);

    listEl.appendChild(block);
  });
}

// Build a small square action button.
function makeIconBtn(text, title, disabled, onClick) {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = text;
  btn.title = title;
  btn.disabled = disabled;
  if (!disabled) btn.addEventListener("click", onClick);
  return btn;
}

// ---- Course operations ----
function addCourse() {
  const name = courseNameInput.value.trim();
  courseError.textContent = "";

  if (!name) {
    courseError.textContent = "Please enter a course name.";
    return;
  }

  courses.push({ name, links: [] });
  courseNameInput.value = "";
  render();
}

function removeCourse(ci) {
  courses.splice(ci, 1);
  render();
}

function moveCourse(ci, direction) {
  const target = ci + direction;
  if (target < 0 || target >= courses.length) return;
  [courses[ci], courses[target]] = [courses[target], courses[ci]];
  render();
}

// ---- Link operations ----
function addLink(ci, labelInput, urlInput, errEl) {
  const label = labelInput.value.trim();
  const url = urlInput.value.trim();
  errEl.textContent = "";

  if (!label) {
    errEl.textContent = "Please enter a link label.";
    return;
  }

  if (!url.startsWith("https://")) {
    errEl.textContent = "URL must start with https://";
    return;
  }

  courses[ci].links.push({ label, url });
  render();
}

function removeLink(ci, li) {
  courses[ci].links.splice(li, 1);
  render();
}

function moveLink(ci, li, direction) {
  const links = courses[ci].links;
  const target = li + direction;
  if (target < 0 || target >= links.length) return;
  [links[li], links[target]] = [links[target], links[li]];
  render();
}

// ---- Persist ----
function save() {
  chrome.storage.sync.set({ courses }, () => {
    savedMsg.classList.add("show");
    setTimeout(() => savedMsg.classList.remove("show"), 2000);
  });
}

addCourseBtn.addEventListener("click", addCourse);
saveBtn.addEventListener("click", save);
courseNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCourse();
});
