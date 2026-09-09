import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_HORIZON_MINUTES,
    DEFAULT_TARGETS,
    parseTargets,
    resolveConfig,
    resolveHorizonMinutes,
} from "../src/config";
import { makeEnv } from "./helpers";

describe("parseTargets", () => {
    it("defaults when unset (A1)", () => {
        expect(parseTargets(DEFAULT_TARGETS)).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 11, minutes: 0 },
            { hours: 16, minutes: 0 },
            { hours: 21, minutes: 0 },
        ]);
    });

    it("parses a short list (A2)", () => {
        expect(parseTargets("06:00,11:00")).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 11, minutes: 0 },
        ]);
    });

    it("trims whitespace around entries (A3)", () => {
        expect(parseTargets(" 06:00 , 11:00 ")).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 11, minutes: 0 },
        ]);
    });

    it("skips empty segments from stray commas (A4)", () => {
        expect(parseTargets("06:00,,11:00")).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 11, minutes: 0 },
        ]);
    });

    it("defaults minutes to 0 when no colon is present (A5)", () => {
        expect(parseTargets("6")).toEqual([{ hours: 6, minutes: 0 }]);
    });

    it("sorts targets ascending regardless of input order (A6)", () => {
        expect(parseTargets("21:00,06:00")).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 21, minutes: 0 },
        ]);
    });

    it("throws on a non-numeric entry (A7)", () => {
        expect(() => parseTargets("abc")).toThrow('Invalid entry "abc" in TARGETS_LOCAL');
    });

    it("throws when the minutes half is non-numeric (A8)", () => {
        expect(() => parseTargets("06:xx")).toThrow(/Invalid entry "06:xx"/);
    });

    it("throws on an empty string (A9)", () => {
        expect(() => parseTargets("")).toThrow("TARGETS_LOCAL is empty");
    });

    it("throws on a string of only commas (A10)", () => {
        expect(() => parseTargets(",")).toThrow("TARGETS_LOCAL is empty");
    });
});

describe("resolveHorizonMinutes", () => {
    it("defaults to 240 when unset (A11)", () => {
        expect(resolveHorizonMinutes(undefined)).toBe(DEFAULT_HORIZON_MINUTES);
    });

    it("parses a valid numeric string (A12)", () => {
        expect(resolveHorizonMinutes("60")).toBe(60);
    });

    it("bug fix: falls back rather than silently yielding 0 for an empty string (A13)", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(resolveHorizonMinutes("")).toBe(DEFAULT_HORIZON_MINUTES);
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('"event":"config.invalid"'));
        spy.mockRestore();
    });

    it("bug fix: falls back rather than silently yielding NaN for a malformed value (A14)", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(resolveHorizonMinutes("abc")).toBe(DEFAULT_HORIZON_MINUTES);
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("CATCHUP_HORIZON_MINUTES"));
        spy.mockRestore();
    });

    it("falls back for a negative or zero value", () => {
        expect(resolveHorizonMinutes("0")).toBe(DEFAULT_HORIZON_MINUTES);
        expect(resolveHorizonMinutes("-5")).toBe(DEFAULT_HORIZON_MINUTES);
    });
});

describe("resolveConfig verbose flag (A15)", () => {
    it("is verbose by default", () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }));
        expect(result.ok && result.config.verbose).toBe(true);
    });

    it('is quiet only for the literal string "false"', () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, VERBOSE: "false" }));
        expect(result.ok && result.config.verbose).toBe(false);
    });

    it('treats "0" as verbose (only the literal "false" disables it)', () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, VERBOSE: "0" }));
        expect(result.ok && result.config.verbose).toBe(true);
    });

    it('treats "true" as verbose', () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, VERBOSE: "true" }));
        expect(result.ok && result.config.verbose).toBe(true);
    });
});

describe("resolveConfig", () => {
    it("returns ok:true with resolved fields for valid input", () => {
        const result = resolveConfig(
            makeEnv({
                WARMUP_STATE: env.WARMUP_STATE,
                TARGETS_LOCAL: "06:00,18:00",
                TARGET_TIMEZONE: "America/New_York",
                CATCHUP_HORIZON_MINUTES: "30",
            })
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("expected ok");
        expect(result.config.timeZone).toBe("America/New_York");
        expect(result.config.horizonMinutes).toBe(30);
        expect(result.config.horizonMs).toBe(30 * 60_000);
        expect(result.config.targets).toEqual([
            { hours: 6, minutes: 0 },
            { hours: 18, minutes: 0 },
        ]);
    });

    it("bug fix: returns ok:false instead of throwing for a bad TARGETS_LOCAL (G8)", () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, TARGETS_LOCAL: "not-a-time" }));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected failure");
        expect(result.error).toMatch(/Invalid entry/);
    });

    it("defaults the timezone when unset", () => {
        const result = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE }));
        expect(result.ok && result.config.timeZone).toBe("Europe/Dublin");
    });

    it("accepts the OpenAI provider and rejects unknown providers", () => {
        const openai = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, WARMUP_PROVIDER: "openai" }));
        expect(openai.ok && openai.config.provider).toBe("openai");
        const invalid = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, WARMUP_PROVIDER: "gpt" }));
        expect(invalid.ok).toBe(false);
        expect(!invalid.ok && invalid.error).toMatch(/WARMUP_PROVIDER/);
        const invalidAlias = resolveConfig(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, WARMUP_PROVIDERS: undefined, WARMUP_PROVIDER: "gpt" }));
        expect(invalidAlias.ok).toBe(false);
    });

    it("resolves both providers and rejects duplicate or conflicting settings", () => {
        const both = resolveConfig(makeEnv({ WARMUP_PROVIDERS: "claude, openai", WARMUP_STATE: env.WARMUP_STATE }));
        expect(both.ok && both.config.providers).toEqual(["claude", "openai"]);
        const duplicate = resolveConfig(makeEnv({ WARMUP_PROVIDERS: "claude,claude", WARMUP_STATE: env.WARMUP_STATE }));
        expect(duplicate.ok).toBe(false);
        expect(!duplicate.ok && duplicate.error).toMatch(/Duplicate/);
        const conflict = resolveConfig(makeEnv({ WARMUP_PROVIDERS: "claude", WARMUP_PROVIDER: "openai", WARMUP_STATE: env.WARMUP_STATE }));
        expect(conflict.ok).toBe(false);
        expect(!conflict.ok && conflict.error).toMatch(/disagree/);
    });

    it("rejects an explicitly empty provider list", () => {
        const result = resolveConfig(makeEnv({ WARMUP_PROVIDERS: ",", WARMUP_STATE: env.WARMUP_STATE }));
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toMatch(/empty/);
    });
});
