import { describe, expect, it } from "vitest";
import { extractFriendCode } from "./friendCode";

describe("extractFriendCode", () => {
  it("extracts the code from an /add-friend link", () => {
    expect(extractFriendCode("https://veyra.example/add-friend?code=K7M2P9QX4T")).toBe("K7M2P9QX4T");
  });

  it("accepts the ?friend= alias and deep links", () => {
    expect(extractFriendCode("https://veyra.example/u/alice?friend=k7m2p9qx4t")).toBe("K7M2P9QX4T");
    expect(extractFriendCode("veyra://user/alice?friend=K7M2P9QX4T")).toBe("K7M2P9QX4T");
  });

  it("accepts a bare code", () => {
    expect(extractFriendCode("k7m2p9qx4t")).toBe("K7M2P9QX4T");
  });

  it("rejects unrelated input", () => {
    expect(extractFriendCode("")).toBeNull();
    expect(extractFriendCode("hello world")).toBeNull();
    expect(extractFriendCode("https://example.com/")).toBeNull();
  });
});
