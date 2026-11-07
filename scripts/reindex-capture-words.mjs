#!/usr/bin/env node
// Build first; --db is explicit so proof can use a copied store.
import { openStore } from "../dist/core/store/open-store.js";
import { reindexRecentCompanyFiles } from "../dist/core/indexer/index-file.js";
const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dbPath = value("--db"),
  since = value("--since");
const roots = (process.env.COMPASS_COMPANY_ROOTS ?? "").split(":").filter(Boolean);
if (!dbPath || !since || !roots.length) {
  console.error("Requires --db <store> --since <capture floor> and COMPASS_COMPANY_ROOTS");
  process.exitCode = 1;
} else {
  const db = openStore(dbPath);
  try {
    console.log(JSON.stringify(await reindexRecentCompanyFiles(db, { since, roots })));
  } finally {
    db.close();
  }
}
