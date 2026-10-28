import { expect, test } from "bun:test";
import { parseCredentials } from "./config";

test("credentials require both values and trim whitespace", () => {
  expect(() => parseCredentials({ tokenId: "id", tokenSecret: " " })).toThrow();
  expect(parseCredentials({ tokenId: " id ", tokenSecret: " secret " })).toEqual({ tokenId: "id", tokenSecret: "secret" });
});
