import { describe, expect, it } from "vite-plus/test";

import { sameSettings } from "./settings.ts";

describe("sameSettings", () => {
  it("ignores formatting and key order", () => {
    expect(
      sameSettings(
        '{"a":1,"b":{"x":true,"y":[1,2]}}',
        '{\n  "b": { "y": [1, 2], "x": true },\n  "a": 1\n}',
      ),
    ).toBe(true);
  });

  it("tells changed values and array order apart", () => {
    expect(sameSettings('{"effort":"high"}', '{"effort":"medium"}')).toBe(false);
    expect(sameSettings('{"a":[1,2]}', '{"a":[2,1]}')).toBe(false);
  });

  it("treats unreadable JSON as different", () => {
    expect(sameSettings("{", "{")).toBe(false);
  });
});
