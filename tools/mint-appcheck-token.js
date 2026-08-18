#!/usr/bin/env node
/**
 * Print a fresh App Check token for testing the Worker gates.
 *
 * Needs a HEADED browser: reCAPTCHA v3 refuses headless ones, which is the
 * protection working — and also why tests/appcheck-verify.test.js skips its
 * positive case unless APPCHECK_TOKEN is supplied.
 *
 * Usage: node tools/mint-appcheck-token.js
 *        APPCHECK_TOKEN=$(node tools/mint-appcheck-token.js) node tests/appcheck-verify.test.js
 */
'use strict';
console.error('See tools/README-appcheck.md — minting needs a headed browser session.');
console.error('The token lasts ~1 hour and must never be committed (public repo).');
process.exit(1);
