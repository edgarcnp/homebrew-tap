import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPIMAGE_ARCH,
  BREW_ARCH,
  resolveArchitecture,
  resolveBrewArch,
} from "../../lib/core/architecture.ts";

describe("architecture table", () => {
  it("maps every deb arch to its AppImage and Brew spellings", () => {
    assert.equal(APPIMAGE_ARCH.amd64, "x86_64");
    assert.equal(APPIMAGE_ARCH.arm64, "aarch64");
    assert.equal(BREW_ARCH.amd64, "x86_64");
    assert.equal(BREW_ARCH.arm64, "arm64");
  });

  it("resolves every accepted spelling and rejects the rest", () => {
    assert.equal(resolveArchitecture("amd64"), "amd64");
    assert.equal(resolveArchitecture("x86_64"), "amd64");
    assert.equal(resolveArchitecture("arm64"), "arm64");
    assert.equal(resolveArchitecture("aarch64"), "arm64");
    assert.throws(() => resolveArchitecture("riscv64"), /Unsupported AppImage architecture/);
  });

  it("resolves the cask depends_on symbol and rejects the rest", () => {
    assert.equal(resolveBrewArch("x86_64"), "amd64");
    assert.equal(resolveBrewArch("arm64"), "arm64");
    assert.throws(() => resolveBrewArch("i686"), /unsupported depends_on arch/);
  });
});
