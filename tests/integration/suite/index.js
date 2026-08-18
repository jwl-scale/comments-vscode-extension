'use strict';
const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');
const { TIMEOUT_SCALE } = require('./util');

exports.run = function run() {
  // Per-test budget lives here alone. It must exceed what until() will wait, or
// mocha kills the test before the assertion's own timeout can report anything
// useful — so both scale by the same CI factor.
const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 30000 * TIMEOUT_SCALE });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
    mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
};
