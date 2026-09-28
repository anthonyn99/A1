/* ============================================================================
 * StudyOS drills — ER → relational schema
 * ============================================================================
 * An ER description, three candidate schemas; pick the one that implements it
 * correctly. Every wrong option is a CLASSIC mistake, and its explanation
 * names it:
 *
 *   1:N    the foreign key goes on the MANY side
 *   M:N    needs an intersection (associative) table with a composite key
 *   1:1    FK on either side, with UNIQUE so it stays one-to-one
 *   weak   a weak entity's key includes its owner's key
 *   attr   a relationship's own attribute lives on the intersection table
 *
 * `correct` is always index 0 in the data; options are shuffled on screen.
 * The CREATE TABLE text is plain SQL — verify-sql.mjs loads every option into
 * SQLite to prove each one at least parses.
 * ------------------------------------------------------------------------- */

export const EXERCISES = [
  {
    topic: 'ER: 1:N',
    er: 'A DEPARTMENT employs many EMPLOYEEs; each EMPLOYEE works in exactly one DEPARTMENT.',
    options: [
      { sql: 'CREATE TABLE DEPARTMENT (DeptID INT PRIMARY KEY, DeptName VARCHAR(30));\nCREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30),\n  DeptID INT NOT NULL REFERENCES DEPARTMENT(DeptID));',
        why: 'Right: the foreign key sits on the MANY side (EMPLOYEE), and NOT NULL enforces "exactly one department".' },
      { sql: 'CREATE TABLE DEPARTMENT (DeptID INT PRIMARY KEY, DeptName VARCHAR(30),\n  EmpID INT REFERENCES EMPLOYEE(EmpID));\nCREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30));',
        why: 'The FK is on the ONE side: a department row can then hold only one employee.' },
      { sql: 'CREATE TABLE DEPARTMENT (DeptID INT PRIMARY KEY, DeptName VARCHAR(30));\nCREATE TABLE EMPLOYEE (EmpID INT, EmpName VARCHAR(30), DeptID INT,\n  PRIMARY KEY (EmpID, DeptID));',
        why: 'No foreign key at all, and a composite key would let one employee sit in several departments.' },
    ],
  },
  {
    topic: 'ER: M:N',
    er: 'A STUDENT enrolls in many COURSEs, and a COURSE has many STUDENTs. Each enrollment records a Grade.',
    options: [
      { sql: 'CREATE TABLE STUDENT (StudentID INT PRIMARY KEY, Name VARCHAR(30));\nCREATE TABLE COURSE (CourseID CHAR(8) PRIMARY KEY, Title VARCHAR(40));\nCREATE TABLE ENROLLMENT (StudentID INT REFERENCES STUDENT(StudentID),\n  CourseID CHAR(8) REFERENCES COURSE(CourseID), Grade CHAR(2),\n  PRIMARY KEY (StudentID, CourseID));',
        why: 'Right: M:N needs an intersection table whose key is BOTH foreign keys; Grade belongs to the enrollment, so it lives there.' },
      { sql: 'CREATE TABLE STUDENT (StudentID INT PRIMARY KEY, Name VARCHAR(30),\n  CourseID CHAR(8) REFERENCES COURSE(CourseID), Grade CHAR(2));\nCREATE TABLE COURSE (CourseID CHAR(8) PRIMARY KEY, Title VARCHAR(40));',
        why: 'An FK in STUDENT allows only ONE course per student — that is 1:N, not M:N.' },
      { sql: 'CREATE TABLE STUDENT (StudentID INT PRIMARY KEY, Name VARCHAR(30), Grade CHAR(2));\nCREATE TABLE COURSE (CourseID CHAR(8) PRIMARY KEY, Title VARCHAR(40));\nCREATE TABLE ENROLLMENT (StudentID INT, CourseID CHAR(8), PRIMARY KEY (StudentID));',
        why: 'Grade is per enrollment, not per student, and keying ENROLLMENT on StudentID alone allows one course per student.' },
    ],
  },
  {
    topic: 'ER: 1:1',
    er: 'Each EMPLOYEE may be assigned at most one company LAPTOP, and each LAPTOP to at most one EMPLOYEE.',
    options: [
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30));\nCREATE TABLE LAPTOP (SerialNo VARCHAR(20) PRIMARY KEY,\n  EmpID INT UNIQUE REFERENCES EMPLOYEE(EmpID));',
        why: 'Right: the FK may go on either side, but it needs UNIQUE — otherwise one employee could hold many laptops. Nullable, because the assignment is optional.' },
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30));\nCREATE TABLE LAPTOP (SerialNo VARCHAR(20) PRIMARY KEY,\n  EmpID INT REFERENCES EMPLOYEE(EmpID));',
        why: 'Without UNIQUE on EmpID this is 1:N — an employee could be assigned several laptops.' },
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30));\nCREATE TABLE LAPTOP (SerialNo VARCHAR(20), EmpID INT NOT NULL REFERENCES EMPLOYEE(EmpID),\n  PRIMARY KEY (SerialNo, EmpID));',
        why: 'NOT NULL makes the assignment mandatory, and the composite key lets a laptop pair with many employees.' },
    ],
  },
  {
    topic: 'ER: weak entity',
    er: 'An APARTMENT_BUILDING has many APARTMENTs. An apartment is identified by its number WITHIN its building (Apt 3 exists in many buildings).',
    options: [
      { sql: 'CREATE TABLE BUILDING (BuildingID INT PRIMARY KEY, Street VARCHAR(40));\nCREATE TABLE APARTMENT (BuildingID INT REFERENCES BUILDING(BuildingID),\n  AptNumber INT, Bedrooms INT, PRIMARY KEY (BuildingID, AptNumber));',
        why: 'Right: an ID-dependent (weak) entity\'s key includes its owner\'s key — (BuildingID, AptNumber).' },
      { sql: 'CREATE TABLE BUILDING (BuildingID INT PRIMARY KEY, Street VARCHAR(40));\nCREATE TABLE APARTMENT (AptNumber INT PRIMARY KEY, Bedrooms INT,\n  BuildingID INT REFERENCES BUILDING(BuildingID));',
        why: 'AptNumber alone cannot be the key: "Apt 3" exists in many buildings.' },
      { sql: 'CREATE TABLE BUILDING (BuildingID INT PRIMARY KEY, Street VARCHAR(40), AptNumber INT);\nCREATE TABLE APARTMENT (AptNumber INT, Bedrooms INT);',
        why: 'A building row can hold only one apartment number, and APARTMENT has no key or link at all.' },
    ],
  },
  {
    topic: 'ER: recursive',
    er: 'An EMPLOYEE may supervise many other EMPLOYEEs; each employee has at most one supervisor.',
    options: [
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30),\n  SupervisorID INT REFERENCES EMPLOYEE(EmpID));',
        why: 'Right: a recursive 1:N is a foreign key into the SAME table, on the "many" (supervised) side, nullable for the top boss.' },
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30));\nCREATE TABLE SUPERVISOR (SupervisorID INT PRIMARY KEY, EmpName VARCHAR(30));',
        why: 'A supervisor IS an employee; a second table duplicates people and links nothing.' },
      { sql: 'CREATE TABLE EMPLOYEE (EmpID INT PRIMARY KEY, EmpName VARCHAR(30),\n  SupervisesID INT UNIQUE REFERENCES EMPLOYEE(EmpID));',
        why: 'Storing whom you supervise, with UNIQUE, lets a supervisor have only ONE report.' },
    ],
  },
  {
    topic: 'ER: M:N',
    er: 'A PROJECT uses many PARTs and a PART is used in many PROJECTs; for each pair we store the Quantity used.',
    options: [
      { sql: 'CREATE TABLE PROJECT (ProjectID INT PRIMARY KEY, Name VARCHAR(30));\nCREATE TABLE PART (PartNo VARCHAR(10) PRIMARY KEY, Description VARCHAR(40));\nCREATE TABLE PROJECT_PART (ProjectID INT REFERENCES PROJECT(ProjectID),\n  PartNo VARCHAR(10) REFERENCES PART(PartNo), Quantity INT,\n  PRIMARY KEY (ProjectID, PartNo));',
        why: 'Right: the relationship\'s attribute (Quantity) belongs to the intersection table keyed by both sides.' },
      { sql: 'CREATE TABLE PROJECT (ProjectID INT PRIMARY KEY, Name VARCHAR(30), Quantity INT);\nCREATE TABLE PART (PartNo VARCHAR(10) PRIMARY KEY, Description VARCHAR(40), Quantity INT);',
        why: 'Quantity depends on the PAIR (project, part), so it cannot live on either entity alone — and nothing links them.' },
      { sql: 'CREATE TABLE PROJECT (ProjectID INT PRIMARY KEY, Name VARCHAR(30));\nCREATE TABLE PART (PartNo VARCHAR(10) PRIMARY KEY, Description VARCHAR(40),\n  ProjectID INT REFERENCES PROJECT(ProjectID), Quantity INT);',
        why: 'An FK in PART means each part belongs to ONE project — that is 1:N.' },
    ],
  },
];

const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export function mount(host, ctx) {
  const { esc } = ctx;
  const open = (i) => {
    const idx = (i + EXERCISES.length) % EXERCISES.length;
    const ex = EXERCISES[idx];
    const opts = shuffle(ex.options.map((o, k) => ({ ...o, k })));
    host.innerHTML = `
      <div class="sp-row" style="margin-bottom:8px"><span class="sp-muted" style="font-family:var(--mono);font-size:12px">${idx + 1} / ${EXERCISES.length} · ${esc(ex.topic)}</span>
        <span style="margin-left:auto" class="sp-row"><button class="sp-btn" data-prev>‹</button><button class="sp-btn" data-next>›</button></span></div>
      <div class="sp-panel" style="font-size:15px;line-height:1.5">${esc(ex.er)}<div class="sp-muted" style="font-size:12px;margin-top:6px">Which schema implements it correctly?</div></div>
      <div class="sp-choices">${opts.map((o, j) => `<button class="sp-choice" data-k="${o.k}"><div class="sp-code" style="border:none;background:none;padding:0">${esc(o.sql)}</div></button>`).join('')}</div>
      <div data-fb style="margin-top:10px"></div>`;
    host.querySelector('[data-prev]').onclick = () => open(idx - 1);
    host.querySelector('[data-next]').onclick = () => open(idx + 1);
    host.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => {
        const k = Number(b.dataset.k);
        const ok = k === 0;
        ctx.record({ topic: ex.topic, correct: ok, difficulty: 2 });
        host.querySelectorAll('[data-k]').forEach((x) => { x.disabled = true; if (x.dataset.k === '0') x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
        host.querySelector('[data-fb]').innerHTML = `
          <div class="sp-panel"><div class="${ok ? 'sp-ok' : 'sp-bad'}" style="margin-bottom:6px">${ok ? '✓ Correct' : '✗ Not quite'}</div>
          ${ex.options.map((o, j) => `<div style="font-size:13px;margin:4px 0">${j === 0 ? '<span class="sp-ok">✓</span>' : '<span class="sp-bad">✗</span>'} ${esc(o.why)}</div>`).join('')}
          <button class="sp-btn primary" data-go style="margin-top:8px">Next</button></div>`;
        host.querySelector('[data-go]').onclick = () => open(idx + 1);
      };
    });
  };
  open(0);
  return null;
}

export default { mount, EXERCISES };
