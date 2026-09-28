/* ============================================================================
 * StudyOS drills — SQL challenges  (CS 3410, Kroenke ch. 2, parts 1–2)
 * ============================================================================
 * Ordered the way the lecture builds up: one table, filtering, sorting,
 * aggregates, grouping, then subqueries and joins. Each challenge:
 *
 *   { id, dataset, topic, prompt, solution, orderBy?, columns?, hints[3] }
 *
 * `solution` is only ever RUN (to produce the expected result set), never
 * compared as text, so any correct query passes. verify-sql.mjs runs every
 * solution through the grader against itself — a challenge whose own answer
 * does not pass is caught before she ever sees it.
 *
 * Hints unlock one per failed attempt (or on request): a nudge, then the
 * clause she needs, then most of the query.
 * ------------------------------------------------------------------------- */

export const CHALLENGES = [
  // ── One table ────────────────────────────────────────────────────────────
  { id: 'sql01', topic: 'SELECT', prompt: 'List the SKU, SKU_Description and Department of every item in SKU_DATA.',
    solution: 'SELECT SKU, SKU_Description, Department FROM SKU_DATA;',
    hints: ['Name the three columns after SELECT.', 'SELECT col1, col2, col3 FROM table', 'SELECT SKU, SKU_Description, Department FROM ___;'] },
  { id: 'sql02', topic: 'DISTINCT', prompt: 'List each distinct combination of Buyer and Department in SKU_DATA (no duplicate rows).',
    solution: 'SELECT DISTINCT Buyer, Department FROM SKU_DATA;',
    hints: ['Several SKUs share a buyer — how do you remove repeated rows?', 'DISTINCT goes right after SELECT.', 'SELECT DISTINCT Buyer, Department FROM ___;'] },
  { id: 'sql03', topic: 'TOP / LIMIT', prompt: 'Show the 3 order lines with the highest ExtendedPrice (all ORDER_ITEM columns), highest first. TOP or LIMIT both work.',
    solution: 'SELECT * FROM ORDER_ITEM ORDER BY ExtendedPrice DESC LIMIT 3;', orderBy: [{ col: 'ExtendedPrice', dir: 'desc' }],
    hints: ['Sort first, then keep only the first few rows.', 'ORDER BY ExtendedPrice DESC, then TOP 3 (or LIMIT 3).', 'SELECT TOP 3 * FROM ORDER_ITEM ORDER BY ___ DESC;'] },
  { id: 'sql04', topic: 'WHERE', prompt: 'Show all columns of SKU_DATA for the Water Sports department.',
    solution: "SELECT * FROM SKU_DATA WHERE Department = 'Water Sports';",
    hints: ['Filter rows with WHERE.', "Text literals take single quotes: 'Water Sports'.", "SELECT * FROM SKU_DATA WHERE Department = ___;"] },
  { id: 'sql05', topic: 'WHERE', prompt: 'Show SKU and SKU_Description for every item whose SKU is greater than 200000.',
    solution: 'SELECT SKU, SKU_Description FROM SKU_DATA WHERE SKU > 200000;',
    hints: ['Numbers take no quotes.', 'WHERE SKU > 200000', 'SELECT SKU, SKU_Description FROM SKU_DATA WHERE ___;'] },
  { id: 'sql06', topic: 'AND / OR / NOT', prompt: 'Show all columns of the Water Sports items bought by Nancy Meyers.',
    solution: "SELECT * FROM SKU_DATA WHERE Department = 'Water Sports' AND Buyer = 'Nancy Meyers';",
    hints: ['Both conditions must hold.', 'Join two conditions with AND.', "WHERE Department = 'Water Sports' AND Buyer = ___"] },
  { id: 'sql07', topic: 'IN', prompt: 'Show SKU, SKU_Description and Department for items in the Camping or Climbing departments.',
    solution: "SELECT SKU, SKU_Description, Department FROM SKU_DATA WHERE Department IN ('Camping', 'Climbing');",
    hints: ['Either OR, or a set of values.', "Department IN ('Camping', 'Climbing')", "SELECT SKU, SKU_Description, Department FROM SKU_DATA WHERE Department IN (___);"] },
  { id: 'sql08', topic: 'IN', prompt: 'Show all columns of the items NOT bought by Nancy Meyers, Cindy Lo or Jerry Martin.',
    solution: "SELECT * FROM SKU_DATA WHERE Buyer NOT IN ('Nancy Meyers', 'Cindy Lo', 'Jerry Martin');",
    hints: ['The opposite of IN.', 'NOT IN (list)', "WHERE Buyer NOT IN ('Nancy Meyers', ___, ___)"] },
  { id: 'sql09', topic: 'BETWEEN', prompt: 'Show all ORDER_ITEM rows with ExtendedPrice from 100 to 200 inclusive, sorted by ExtendedPrice ascending.',
    solution: 'SELECT * FROM ORDER_ITEM WHERE ExtendedPrice BETWEEN 100 AND 200 ORDER BY ExtendedPrice;', orderBy: [{ col: 'ExtendedPrice', dir: 'asc' }],
    hints: ['BETWEEN is inclusive at both ends.', 'WHERE ExtendedPrice BETWEEN 100 AND 200, then ORDER BY.', 'SELECT * FROM ORDER_ITEM WHERE ExtendedPrice BETWEEN ___ ORDER BY ExtendedPrice;'] },
  { id: 'sql10', topic: 'LIKE', prompt: "Show all columns of the items whose description contains the word 'Tent'.",
    solution: "SELECT * FROM SKU_DATA WHERE SKU_Description LIKE '%Tent%';",
    hints: ['Pattern matching uses LIKE.', '% matches any run of characters, on either side.', "WHERE SKU_Description LIKE ___"] },
  { id: 'sql11', topic: 'LIKE', prompt: "Show all columns of the items whose SKU has a 2 in the third-from-last position (e.g. …2xx). Use LIKE with the _ wildcard.",
    solution: "SELECT * FROM SKU_DATA WHERE SKU LIKE '%2__';",
    hints: ['_ matches exactly one character.', "The last two characters are anything: '__'.", "WHERE SKU LIKE '%2__'"] },
  { id: 'sql12', topic: 'NULL', prompt: 'Show all columns of the 2020 catalog items that were NOT in the printed catalog (their CatalogPage is missing).',
    solution: 'SELECT * FROM CATALOG_SKU_2020 WHERE CatalogPage IS NULL;',
    hints: ['A missing value is NULL — and = NULL never matches.', 'Use IS NULL.', 'SELECT * FROM CATALOG_SKU_2020 WHERE CatalogPage IS ___;'] },

  // ── Aggregates and expressions ──────────────────────────────────────────
  { id: 'sql13', topic: 'Aggregates', prompt: 'What is the total of all OrderTotal values in RETAIL_ORDER? Name the column OrderSum.',
    solution: 'SELECT SUM(OrderTotal) AS OrderSum FROM RETAIL_ORDER;', columns: ['OrderSum'],
    hints: ['A built-in aggregate function adds a column up.', 'SUM(OrderTotal) … AS OrderSum', 'SELECT SUM(OrderTotal) AS ___ FROM RETAIL_ORDER;'] },
  { id: 'sql14', topic: 'Aggregates', prompt: 'In one row, show the SUM, AVG, MIN and MAX of ExtendedPrice across ORDER_ITEM.',
    solution: 'SELECT SUM(ExtendedPrice), AVG(ExtendedPrice), MIN(ExtendedPrice), MAX(ExtendedPrice) FROM ORDER_ITEM;',
    hints: ['Four aggregate functions, one SELECT.', 'SELECT SUM(x), AVG(x), MIN(x), MAX(x) FROM …', 'SELECT SUM(ExtendedPrice), AVG(ExtendedPrice), ___ FROM ORDER_ITEM;'] },
  { id: 'sql15', topic: 'Aggregates', prompt: 'How many different departments appear in SKU_DATA? (One number.)',
    solution: 'SELECT COUNT(DISTINCT Department) FROM SKU_DATA;',
    hints: ['COUNT counts rows; you want distinct values.', 'COUNT(DISTINCT column)', 'SELECT COUNT(DISTINCT ___) FROM SKU_DATA;'] },
  { id: 'sql16', topic: 'Expressions', prompt: 'Find the order lines where Quantity × Price does not equal ExtendedPrice. Show OrderNumber and SKU.',
    solution: 'SELECT OrderNumber, SKU FROM ORDER_ITEM WHERE Quantity * Price <> ExtendedPrice;',
    hints: ['WHERE can compare a calculation with a column.', 'Not-equal is <> in SQL.', 'WHERE Quantity * Price <> ___'] },

  // ── Grouping ────────────────────────────────────────────────────────────
  { id: 'sql17', topic: 'GROUP BY', prompt: 'For each Department, count the 2020 catalog items that appeared in the printed catalog (CatalogPage not null). Show Department and the count.',
    solution: 'SELECT Department, COUNT(SKU) FROM CATALOG_SKU_2020 WHERE CatalogPage IS NOT NULL GROUP BY Department;',
    hints: ['Filter rows with WHERE, then group what is left.', 'GROUP BY Department; COUNT(SKU) per group.', 'SELECT Department, COUNT(SKU) FROM CATALOG_SKU_2020 WHERE CatalogPage IS NOT NULL GROUP BY ___;'] },
  { id: 'sql18', topic: 'HAVING', prompt: 'Same as before, but only show departments with MORE THAN 2 printed-catalog items.',
    solution: 'SELECT Department, COUNT(SKU) FROM CATALOG_SKU_2020 WHERE CatalogPage IS NOT NULL GROUP BY Department HAVING COUNT(SKU) > 2;',
    hints: ['WHERE filters rows; what filters groups?', 'HAVING COUNT(SKU) > 2 goes after GROUP BY.', '… GROUP BY Department HAVING ___;'] },
  { id: 'sql19', topic: 'GROUP BY', prompt: 'Count the SKUs for each combination of Department and Buyer in SKU_DATA.',
    solution: 'SELECT Department, Buyer, COUNT(SKU) FROM SKU_DATA GROUP BY Department, Buyer;',
    hints: ['You can group by more than one column.', 'GROUP BY Department, Buyer', 'SELECT Department, Buyer, COUNT(SKU) FROM SKU_DATA GROUP BY ___;'] },
  { id: 'sql20', topic: 'GROUP BY', prompt: 'Excluding SKU 302000, show each Department with more than one SKU and its SKU count, sorted by that count ascending.',
    solution: 'SELECT Department, COUNT(SKU) AS Dept_SKU_Count FROM SKU_DATA WHERE SKU <> 302000 GROUP BY Department HAVING COUNT(SKU) > 1 ORDER BY Dept_SKU_Count;',
    orderBy: [{ col: 'Dept_SKU_Count', dir: 'asc' }],
    hints: ['WHERE, GROUP BY, HAVING, ORDER BY — in that order.', 'ORDER BY can use the alias of the count.', '… WHERE SKU <> 302000 GROUP BY Department HAVING COUNT(SKU) > 1 ORDER BY ___;'] },

  // ── More than one table ─────────────────────────────────────────────────
  { id: 'sql21', topic: 'Subqueries', prompt: 'What is the total revenue (SUM of ExtendedPrice) from Water Sports items? Find their SKUs with a subquery.',
    solution: "SELECT SUM(ExtendedPrice) FROM ORDER_ITEM WHERE SKU IN (SELECT SKU FROM SKU_DATA WHERE Department = 'Water Sports');",
    hints: ['ORDER_ITEM has no Department column — SKU_DATA does.', 'WHERE SKU IN (SELECT SKU FROM SKU_DATA WHERE …)', "SELECT SUM(ExtendedPrice) FROM ORDER_ITEM WHERE SKU IN (SELECT SKU FROM SKU_DATA WHERE Department = ___);"] },
  { id: 'sql22', topic: 'Subqueries', prompt: 'Show Buyer and Department for each SKU sold in a January 2021 order (one row per SKU). Use nested subqueries.',
    solution: "SELECT Buyer, Department FROM SKU_DATA WHERE SKU IN (SELECT SKU FROM ORDER_ITEM WHERE OrderNumber IN (SELECT OrderNumber FROM RETAIL_ORDER WHERE OrderMonth = 'January' AND OrderYear = 2021));",
    hints: ['Work inside-out: which orders, then which SKUs, then who bought them.', 'Innermost: SELECT OrderNumber FROM RETAIL_ORDER WHERE OrderMonth = … AND OrderYear = …', 'SKU IN (SELECT SKU FROM ORDER_ITEM WHERE OrderNumber IN (SELECT OrderNumber FROM RETAIL_ORDER WHERE ___))'] },
  { id: 'sql23', topic: 'Joins', prompt: 'For every order line, show OrderNumber, SKU_Description and ExtendedPrice (join ORDER_ITEM to SKU_DATA).',
    solution: 'SELECT OI.OrderNumber, S.SKU_Description, OI.ExtendedPrice FROM ORDER_ITEM AS OI JOIN SKU_DATA AS S ON OI.SKU = S.SKU;',
    hints: ['The tables share the SKU column.', 'FROM ORDER_ITEM JOIN SKU_DATA ON ORDER_ITEM.SKU = SKU_DATA.SKU', 'SELECT OrderNumber, SKU_Description, ExtendedPrice FROM ORDER_ITEM JOIN SKU_DATA ON ___;'] },
  { id: 'sql24', topic: 'Joins', prompt: 'Show each Buyer and their total revenue (SUM of ExtendedPrice across the items they buy), highest revenue first.',
    solution: 'SELECT S.Buyer, SUM(OI.ExtendedPrice) AS Revenue FROM ORDER_ITEM AS OI JOIN SKU_DATA AS S ON OI.SKU = S.SKU GROUP BY S.Buyer ORDER BY Revenue DESC;',
    orderBy: [{ col: 'Revenue', dir: 'desc' }],
    hints: ['Join first, then group the joined rows.', 'GROUP BY Buyer, ORDER BY the sum DESC.', 'SELECT Buyer, SUM(ExtendedPrice) AS Revenue FROM ORDER_ITEM JOIN SKU_DATA ON ORDER_ITEM.SKU = SKU_DATA.SKU GROUP BY ___ ORDER BY Revenue DESC;'] },
  { id: 'sql25', topic: 'Joins', prompt: 'Show OrderNumber, StoreNumber and SKU_Description for every item sold in store 10. (Three tables.)',
    solution: 'SELECT RO.OrderNumber, RO.StoreNumber, S.SKU_Description FROM RETAIL_ORDER AS RO JOIN ORDER_ITEM AS OI ON RO.OrderNumber = OI.OrderNumber JOIN SKU_DATA AS S ON OI.SKU = S.SKU WHERE RO.StoreNumber = 10;',
    hints: ['RETAIL_ORDER → ORDER_ITEM → SKU_DATA.', 'Two JOINs: on OrderNumber, then on SKU.', '… FROM RETAIL_ORDER JOIN ORDER_ITEM ON … JOIN SKU_DATA ON … WHERE StoreNumber = 10;'] },
  { id: 'sql26', topic: 'Outer joins', prompt: 'List EVERY buyer with the number of SKUs they buy — including buyers who buy none (show 0 for them).',
    solution: 'SELECT B.BuyerName, COUNT(S.SKU) FROM BUYER AS B LEFT JOIN SKU_DATA AS S ON B.BuyerName = S.Buyer GROUP BY B.BuyerName;',
    hints: ['An inner join drops buyers with no match.', 'LEFT JOIN from BUYER keeps every buyer; COUNT(S.SKU) ignores the NULLs.', 'SELECT BuyerName, COUNT(SKU) FROM BUYER LEFT JOIN SKU_DATA ON BuyerName = Buyer GROUP BY ___;'] },
  { id: 'sql27', topic: 'Subqueries', prompt: 'Which SKUs have never been ordered? Show SKU and SKU_Description.',
    solution: 'SELECT SKU, SKU_Description FROM SKU_DATA WHERE SKU NOT IN (SELECT SKU FROM ORDER_ITEM);',
    hints: ['Every ordered SKU appears in ORDER_ITEM.', 'NOT IN (a subquery), or a LEFT JOIN … WHERE … IS NULL.', 'WHERE SKU NOT IN (SELECT SKU FROM ___)'] },
].map((c) => ({ dataset: 'capecodd', module: 'Module 2', ...c }));

export const TOPICS = [...new Set(CHALLENGES.map((c) => c.topic))];

export default { CHALLENGES, TOPICS };
