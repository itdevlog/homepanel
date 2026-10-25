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

const devices = readFileSync(
  new URL("../../static/views/devices.js", import.meta.url),
  "utf8",
);
const settings = readFileSync(
  new URL("../../static/views/settings.js", import.meta.url),
  "utf8",
);

test("home renders infrastructure by rooms", () => {
  assert.match(home, /infraBlock/);
  assert.match(home, /infra-grid/);
});

test("device editor exposes role and room", () => {
  assert.match(devices, /name="role"/);
  assert.match(devices, /name="room"/);
});

test("label rules support role and room", () => {
  assert.match(settings, /rule-role/);
  assert.match(settings, /rule-room/);
});
