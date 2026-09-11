#!/usr/bin/env node
"use strict";
require("../lib/cli").main()
  .catch((error) => { console.error(`rig: ${error.message}`); process.exitCode = 1; });
