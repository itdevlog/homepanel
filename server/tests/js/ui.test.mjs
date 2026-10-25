import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(
  new URL("../../static/views/home.js", import.meta.url),
  "utf8",
);

test("router card offers agent restart", () => {
  assert.match(home, /router-restart/);
  assert.match(home, /controlRestart/);
});
