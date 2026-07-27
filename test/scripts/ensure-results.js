"use strict";

const fs = require("fs");
const path = require("path");

fs.mkdirSync(path.resolve(__dirname, "../results"), { recursive: true });
