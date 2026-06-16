import { Fact } from "./types";

export interface IFactExtractor {
	extract(rawPayload: Record<string, any>): Fact;
}
