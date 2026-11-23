/**
 * Repeater sub-field type validation (issue #1424).
 *
 * The Zod enum guarding `validation.subFields[].type` must stay in sync with
 * `REPEATER_SUB_FIELD_TYPES` (schema/types.ts). It was missing "url" (a
 * documented sub-field type the schema-builder UI offers) and gained "image"
 * together with media-picker support in repeater rows.
 */

import { describe, it, expect } from "vitest";

import { createFieldBody } from "../../../src/api/schemas/schema.js";
import { REPEATER_SUB_FIELD_TYPES } from "../../../src/schema/types.js";

function repeaterFieldWith(subFieldType: string) {
	return {
		slug: "gallery",
		label: "Gallery",
		type: "repeater",
		validation: {
			subFields: [{ slug: "entry", type: subFieldType, label: "Entry" }],
		},
	};
}

describe("createFieldBody repeater sub-field types", () => {
	it.each([...REPEATER_SUB_FIELD_TYPES])("accepts %s sub-fields", (type) => {
		const result = createFieldBody.safeParse(repeaterFieldWith(type));
		expect(result.success).toBe(true);
	});

	it("rejects unsupported sub-field types", () => {
		for (const type of ["portableText", "reference", "nonsense"]) {
			const result = createFieldBody.safeParse(repeaterFieldWith(type));
			expect(result.success).toBe(false);
		}
	});
});

describe("createFieldBody nested repeater sub-fields", () => {
	const rates = {
		slug: "rates",
		type: "repeater",
		label: "Rates",
		maxItems: 5,
		subFields: [{ slug: "price", type: "string", label: "Price" }],
	};
	const categories = (products: unknown) => ({
		slug: "categories",
		label: "Categories",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "label", type: "string", label: "Label" },
				{ slug: "products", type: "repeater", label: "Products", subFields: [products] },
			],
		},
	});

	it("keeps two nested levels intact", () => {
		const body = categories(rates);
		const result = createFieldBody.safeParse(body);
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.validation).toEqual(body.validation);
	});

	it("rejects a third level with the nesting limit", () => {
		const result = createFieldBody.safeParse(
			categories({ ...rates, subFields: [{ slug: "tiers", type: "repeater", label: "Tiers" }] }),
		);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues).toContainEqual(
			expect.objectContaining({
				path: ["validation", "subFields", 1, "subFields", 0, "subFields", 0, "type"],
				message: "Repeaters can be nested only 2 levels deep",
			}),
		);
	});

	it("rejects a nested repeater with a key it would otherwise drop", () => {
		const { subFields, ...rest } = rates;
		const result = createFieldBody.safeParse(categories({ ...rest, validation: { subFields } }));
		expect(result.success).toBe(false);
	});

	it("needs a nested repeater to define its rows", () => {
		const result = createFieldBody.safeParse(categories({ ...rates, subFields: [] }));
		expect(result.success).toBe(false);
	});
});

describe("createFieldBody reference config", () => {
	it("preserves targetCollection and multiple on the parsed validation", () => {
		const result = createFieldBody.safeParse({
			slug: "author",
			label: "Author",
			type: "reference",
			validation: { targetCollection: "authors", multiple: false },
		});

		expect(result.success).toBe(true);
		expect(result.data?.validation).toMatchObject({
			targetCollection: "authors",
			multiple: false,
		});
	});
});
