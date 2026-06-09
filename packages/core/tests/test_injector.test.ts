import { describe, it, expect } from "vitest";
import { truncateDecisions } from "../src/injector";

describe("TruncateDecisions", () => {
    it("empty list returns empty string", () => {
        expect(truncateDecisions([])).toBe("");
    });

    it("single decision under budget", () => {
        const decisions = [{ text: "short text" }];
        const result = truncateDecisions(decisions);
        expect(result).toBe("short text");
    });

    it("single decision exact budget", () => {
        const text = "x".repeat(750);
        const decisions = [{ text }];
        const result = truncateDecisions(decisions);
        expect(result).toBe(text);
    });

    it("single decision over budget", () => {
        const text = "x".repeat(1000);
        const decisions = [{ text }];
        const result = truncateDecisions(decisions);
        const expected = text.slice(0, 750) + "...";
        expect(result).toBe(expected);
        expect(result.length).toBe(750 + 3);
    });

    it("multiple decisions all under budget", () => {
        const decisions = [{ text: "A" }, { text: "B" }, { text: "C" }];
        const result = truncateDecisions(decisions);
        expect(result).toBe("A\n- B\n- C");
    });

    it("multiple decisions over budget mid item", () => {
        // MAX_CHARS=750, first item uses 700 chars, second has 100 chars
        // Second item should be truncated to 50 chars + "..."
        const decisions = [
            { text: "x".repeat(700) },
            { text: "y".repeat(100) },
        ];
        const result = truncateDecisions(decisions);
        // first: 700 chars of x
        // second: 50 chars of y + "..." (since 700 + 100 > 750, truncated to 50)
        const expected = "x".repeat(700) + "\n- " + "y".repeat(50) + "...";
        expect(result).toBe(expected);
        // third item should NOT appear (break after truncation)
        expect(result.includes("z")).toBe(false);
    });

    it("multiple decisions over budget third not included", () => {
        const decisions = [
            { text: "x".repeat(700) },
            { text: "y".repeat(100) },
            { text: "z".repeat(50) },
        ];
        const result = truncateDecisions(decisions);
        expect(result.includes("z")).toBe(false);
    });

    it("first item already over budget", () => {
        const decisions = [
            { text: "a".repeat(800) },
            { text: "b" },
        ];
        const result = truncateDecisions(decisions);
        const expected = "a".repeat(750) + "...";
        expect(result).toBe(expected);
        expect(result.includes("b")).toBe(false);
    });

    it("multiple items hitting exact fit", () => {
        // Each item fits, total exactly at budget
        const decisions = [
            { text: "x".repeat(400) },
            { text: "y".repeat(350) },
        ];
        const result = truncateDecisions(decisions);
        expect(result).toBe("x".repeat(400) + "\n- " + "y".repeat(350));
    });
});
