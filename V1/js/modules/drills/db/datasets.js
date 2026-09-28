/* ============================================================================
 * StudyOS drills — SQL datasets  (engagement upgrade Phase 3, CS 3410)
 * ============================================================================
 * CAPE_CODD mirrors the SCHEMA of the Cape Codd Outdoor Sports extract that
 * Kroenke's Database Processing (16e) ch. 2 teaches SQL with — same tables,
 * same column names, same SKU numbering and departments — so a query written
 * here reads exactly like the ones in her lecture slides. The ROWS are our own
 * illustrative data (a few more orders than the book, so GROUP BY and joins
 * have something to chew on), not a copy of the textbook's figures.
 *
 * Deliberate features the challenges rely on:
 *   - order 5000 has one line whose ExtendedPrice ≠ Quantity × Price
 *   - SKU 203000 exists but was never ordered (anti-join / NOT IN)
 *   - Mary Smith supervises but buys no SKUs (outer join shows her with 0)
 *   - some 2020 catalog rows have CatalogPage NULL (web-only items)
 *
 * Dates are ISO 'YYYY-MM-DD' text: SQLite compares those correctly as
 * strings, where the book's '01-JAN-2020' would not sort.
 * ------------------------------------------------------------------------- */

export const CAPE_CODD = `
CREATE TABLE BUYER (
  BuyerName   VARCHAR(35) PRIMARY KEY,
  Department  VARCHAR(30) NOT NULL,
  Position    VARCHAR(10),
  Supervisor  VARCHAR(35) REFERENCES BUYER(BuyerName)
);
CREATE TABLE SKU_DATA (
  SKU             INTEGER PRIMARY KEY,
  SKU_Description VARCHAR(35) NOT NULL,
  Department      VARCHAR(30) NOT NULL,
  Buyer           VARCHAR(35) REFERENCES BUYER(BuyerName)
);
CREATE TABLE RETAIL_ORDER (
  OrderNumber INTEGER PRIMARY KEY,
  StoreNumber INTEGER,
  StoreZIP    CHAR(9),
  OrderMonth  CHAR(12),
  OrderYear   INTEGER,
  OrderTotal  NUMERIC(9,2)
);
CREATE TABLE ORDER_ITEM (
  OrderNumber   INTEGER REFERENCES RETAIL_ORDER(OrderNumber),
  SKU           INTEGER REFERENCES SKU_DATA(SKU),
  Quantity      INTEGER,
  Price         NUMERIC(9,2),
  ExtendedPrice NUMERIC(9,2),
  PRIMARY KEY (OrderNumber, SKU)
);
CREATE TABLE CATALOG_SKU_2020 (
  CatalogID       INTEGER PRIMARY KEY,
  SKU             INTEGER,
  SKU_Description VARCHAR(35),
  Department      VARCHAR(30),
  CatalogPage     INTEGER,
  DateOnWebSite   DATE
);
CREATE TABLE CATALOG_SKU_2021 (
  CatalogID       INTEGER PRIMARY KEY,
  SKU             INTEGER,
  SKU_Description VARCHAR(35),
  Department      VARCHAR(30),
  CatalogPage     INTEGER,
  DateOnWebSite   DATE
);

INSERT INTO BUYER VALUES
  ('Mary Smith',   'Purchasing',   'Manager', NULL),
  ('Pete Hansen',  'Water Sports', 'Buyer 3', 'Mary Smith'),
  ('Nancy Meyers', 'Water Sports', 'Buyer 1', 'Pete Hansen'),
  ('Cindy Lo',     'Camping',      'Buyer 2', 'Mary Smith'),
  ('Jerry Martin', 'Climbing',     'Buyer 1', 'Cindy Lo');

INSERT INTO SKU_DATA VALUES
  (100100, 'Std. Scuba Tank, Yellow',          'Water Sports', 'Pete Hansen'),
  (100200, 'Std. Scuba Tank, Magenta',         'Water Sports', 'Pete Hansen'),
  (101100, 'Dive Mask, Small Clear',           'Water Sports', 'Nancy Meyers'),
  (101200, 'Dive Mask, Med Clear',             'Water Sports', 'Nancy Meyers'),
  (201000, 'Half-dome Tent',                   'Camping',      'Cindy Lo'),
  (202000, 'Half-dome Tent Vestibule',         'Camping',      'Cindy Lo'),
  (203000, 'Half-dome Tent Vestibule - Wide',  'Camping',      'Cindy Lo'),
  (301000, 'Light Fly Climbing Harness',       'Climbing',     'Jerry Martin'),
  (302000, 'Locking Carabiner, Oval',          'Climbing',     'Jerry Martin');

INSERT INTO RETAIL_ORDER VALUES
  (1000, 10, '98110', 'December', 2020, 445.00),
  (2000, 20, '02335', 'December', 2020, 310.00),
  (3000, 10, '98110', 'January',  2021, 480.00),
  (4000, 30, '60606', 'January',  2021, 130.00),
  (5000, 20, '02335', 'February', 2021, 375.00),
  (6000, 10, '98110', 'February', 2021, 140.00);

INSERT INTO ORDER_ITEM VALUES
  (1000, 201000, 1, 300.00, 300.00),
  (1000, 202000, 1, 130.00, 130.00),
  (2000, 101100, 4,  50.00, 200.00),
  (2000, 101200, 2,  50.00, 100.00),
  (3000, 100200, 1, 300.00, 300.00),
  (3000, 101100, 2,  50.00, 100.00),
  (3000, 101200, 1,  50.00,  50.00),
  (4000, 301000, 2,  40.00,  80.00),
  (4000, 302000, 4,  10.00,  40.00),
  (5000, 100100, 1, 300.00, 300.00),
  (5000, 301000, 1,  40.00,  40.00),
  (5000, 302000, 3,  10.00,  20.00),
  (6000, 202000, 1, 130.00, 130.00);

INSERT INTO CATALOG_SKU_2020 VALUES
  (20200001, 100100, 'Std. Scuba Tank, Yellow',   'Water Sports', 23,   '2020-01-01'),
  (20200002, 100200, 'Std. Scuba Tank, Magenta',  'Water Sports', NULL, '2020-01-01'),
  (20200003, 101100, 'Dive Mask, Small Clear',    'Water Sports', 24,   '2020-08-01'),
  (20200004, 101200, 'Dive Mask, Med Clear',      'Water Sports', 26,   '2020-01-01'),
  (20200005, 201000, 'Half-dome Tent',            'Camping',      46,   '2020-01-01'),
  (20200006, 202000, 'Half-dome Tent Vestibule',  'Camping',      NULL, '2020-04-01'),
  (20200007, 301000, 'Light Fly Climbing Harness','Climbing',     79,   '2020-01-01'),
  (20200008, 302000, 'Locking Carabiner, Oval',   'Climbing',     NULL, '2020-11-01');

INSERT INTO CATALOG_SKU_2021 VALUES
  (20210001, 100100, 'Std. Scuba Tank, Yellow',          'Water Sports', 23,   '2021-01-01'),
  (20210002, 100200, 'Std. Scuba Tank, Magenta',         'Water Sports', 23,   '2021-01-01'),
  (20210003, 101100, 'Dive Mask, Small Clear',           'Water Sports', NULL, '2021-08-01'),
  (20210004, 101200, 'Dive Mask, Med Clear',             'Water Sports', 26,   '2021-01-01'),
  (20210005, 202000, 'Half-dome Tent Vestibule',         'Camping',      46,   '2021-01-01'),
  (20210006, 203000, 'Half-dome Tent Vestibule - Wide',  'Camping',      NULL, '2021-04-01'),
  (20210007, 301000, 'Light Fly Climbing Harness',       'Climbing',     77,   '2021-01-01'),
  (20210008, 302000, 'Locking Carabiner, Oval',          'Climbing',     79,   '2021-01-01');
`;

export const DATASETS = {
  capecodd: {
    name: 'Cape Codd Outdoor Sports',
    sql: CAPE_CODD,
    tables: ['RETAIL_ORDER', 'ORDER_ITEM', 'SKU_DATA', 'BUYER', 'CATALOG_SKU_2020', 'CATALOG_SKU_2021'],
  },
};

export default { DATASETS, CAPE_CODD };
