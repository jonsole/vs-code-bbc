// examples/fast3d's routines, assembled (build/ is checked in), against its model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks } from "../examples/fast3d/check.mjs";

test("fast3d: every routine matches the model", async () => {
    const failures = await runChecks();
    assert.deepEqual(failures.slice(0, 10), []);
});
