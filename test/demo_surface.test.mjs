import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The demo screen is the manual test harness: each button maps to one SDK
// entry point. A typo here does not fail the build — the button just does
// nothing on a real device — so every reference is proven to exist here.
const projectRoot = path.resolve(import.meta.dirname, "..");
const demoSource = fs.readFileSync(path.join(projectRoot, "scripts/main.gd"), "utf8");
const sdkSource = fs.readFileSync(
  path.join(projectRoot, "addons/godot_mini_game/MiniGameSDK.gd"), "utf8");

const funcs = new Set(
  [...sdkSource.matchAll(/^func ([a-z][A-Za-z0-9_]*)\(/gm)].map((match) => match[1]));
const signals = new Set(
  [...sdkSource.matchAll(/^signal ([A-Za-z0-9_]+)\(/gm)].map((match) => match[1]));
const members = new Set(
  [...sdkSource.matchAll(/^(?:var|const) ([A-Za-z0-9_]+)/gm)].map((match) => match[1]));

const methods = [];
const signalUses = [];
const memberUses = [];
for (const match of demoSource.matchAll(/MiniGameSDK\.([A-Za-z_][A-Za-z0-9_]*)([^\n]*)/g)) {
  const [, name, tail] = match;
  if (/^\s*\.\s*connect\s*\(/.test(tail)) signalUses.push(name);
  else if (/^\s*\(/.test(tail)) methods.push(name);
  else memberUses.push(name);
}

// Guard against the extraction silently matching nothing after a refactor.
assert.ok(methods.length >= 100, `expected the demo SDK surface, found ${methods.length} calls`);
assert.ok(signalUses.length >= 20, `expected the demo signal wiring, found ${signalUses.length} connections`);

const unknownMethods = [...new Set(methods)].filter((name) => !funcs.has(name)).sort();
assert.deepEqual(
  unknownMethods, [],
  `scripts/main.gd calls MiniGameSDK methods that do not exist: ${unknownMethods.join(", ")}`,
);

const unknownSignals = [...new Set(signalUses)].filter((name) => !signals.has(name)).sort();
assert.deepEqual(
  unknownSignals, [],
  `scripts/main.gd connects MiniGameSDK signals that are not declared: ${unknownSignals.join(", ")}`,
);

const unknownMembers = [...new Set(memberUses)]
  .filter((name) => !members.has(name) && !funcs.has(name))
  .sort();
assert.deepEqual(
  unknownMembers, [],
  `scripts/main.gd reads MiniGameSDK members that do not exist: ${unknownMembers.join(", ")}`,
);

// A demo entry point must call the public surface, not an internal helper.
const privateCalls = [...new Set(methods)].filter((name) => name.startsWith("_")).sort();
assert.deepEqual(privateCalls, [], `the demo must not call private SDK helpers: ${privateCalls.join(", ")}`);

console.log(
  `demo_surface.test.mjs: ok (${new Set(methods).size} methods, `
  + `${new Set(signalUses).size} signals, ${new Set(memberUses).size} members)`,
);
