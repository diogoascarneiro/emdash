import { describe, expect, it } from "vitest";

import { mapErrorStatus } from "../../../src/api/errors.js";
import {
	canonicalBlockFields,
	compareBlockFields,
	fingerprintBlockFields,
	validateBlockFields,
} from "../../../src/schema/block-type-contract.js";
import type { BlockFieldDefinition } from "../../../src/schema/block-types.js";

const baseFields: BlockFieldDefinition[] = [
	{
		slug: "heading",
		label: "Heading",
		type: "string",
		required: true,
		validation: { minLength: 2, maxLength: 80 },
	},
	{
		slug: "items",
		label: "Items",
		type: "repeater",
		validation: {
			maxItems: 4,
			subFields: [
				{
					slug: "kind",
					label: "Kind",
					type: "select",
					options: ["news", "guide"],
				},
			],
		},
	},
];

describe("block type contracts", () => {
	it("maps stable registry errors to resource and conflict statuses", () => {
		expect(mapErrorStatus("BLOCK_TYPE_NOT_FOUND")).toBe(404);
		expect(mapErrorStatus("BLOCK_TYPE_EXISTS")).toBe(409);
		expect(mapErrorStatus("BLOCK_TYPE_BREAKING_CHANGE")).toBe(409);
		expect(mapErrorStatus("BLOCK_TYPE_VERSION_CONFLICT")).toBe(409);
	});

	it("produces stable fingerprints that exclude presentation labels", async () => {
		const renamed = baseFields.map((field) => ({ ...field, label: `New ${field.label}` }));

		expect(canonicalBlockFields(renamed)).toBe(canonicalBlockFields(baseFields));
		expect(await fingerprintBlockFields(renamed)).toBe(await fingerprintBlockFields(baseFields));
	});

	it("classifies additive and loosened changes as compatible", () => {
		const next: BlockFieldDefinition[] = [
			{
				...baseFields[0]!,
				validation: { minLength: 1, maxLength: 120 },
			},
			{
				...baseFields[1]!,
				validation: {
					...baseFields[1]!.validation,
					maxItems: 8,
					subFields: [
						{
							slug: "kind",
							label: "Kind",
							type: "select",
							options: ["news", "guide", "video"],
						},
					],
				},
			},
			{ slug: "eyebrow", label: "Eyebrow", type: "string" },
		];

		const result = compareBlockFields(baseFields, next);

		expect(result.compatible).toBe(true);
		expect(result.differences).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "fields.eyebrow", compatibility: "compatible" }),
				expect.objectContaining({
					path: "fields.items.validation.subFields.kind.validation.options",
					compatibility: "compatible",
				}),
			]),
		);
	});

	it("classifies removals, required additions, narrowing, and nested changes as breaking", () => {
		const next: BlockFieldDefinition[] = [
			{
				...baseFields[1]!,
				validation: {
					maxItems: 2,
					subFields: [
						{
							slug: "kind",
							label: "Kind",
							type: "select",
							options: ["news"],
						},
					],
				},
			},
			{ slug: "summary", label: "Summary", type: "text", required: true },
		];

		const result = compareBlockFields(baseFields, next);

		expect(result.compatible).toBe(false);
		expect(result.differences).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "fields.heading", compatibility: "breaking" }),
				expect.objectContaining({ path: "fields.summary", compatibility: "breaking" }),
				expect.objectContaining({
					path: "fields.items.validation.subFields.kind.validation.options",
					compatibility: "breaking",
				}),
			]),
		);
	});

	it("rejects invalid definitions with a stable field path", () => {
		expect(() => validateBlockFields([{ slug: "_key", label: "Key", type: "string" }])).toThrow(
			/fields\[0\]\.slug/,
		);
		expect(() =>
			validateBlockFields([
				{
					slug: "choice",
					label: "Choice",
					type: "select",
					validation: { options: ["one", "one"] },
				},
			]),
		).toThrow(/fields\[0\]\.validation\.options/);
		expect(() =>
			validateBlockFields([
				{
					slug: "rows",
					label: "Rows",
					type: "repeater",
					validation: {
						subFields: [{ slug: "nested", label: "Nested", type: "portableText" as "string" }],
					},
				},
			]),
		).toThrow(/fields\[0\]\.validation\.subFields\[0\]\.type/);
	});
});

describe("block type contracts with nested repeaters", () => {
	function rateCards(rates: Record<string, unknown>): BlockFieldDefinition[] {
		return [
			{
				slug: "categories",
				label: "Categories",
				type: "repeater",
				validation: {
					subFields: [
						{ slug: "label", label: "Label", type: "string" },
						{
							slug: "products",
							label: "Products",
							type: "repeater",
							subFields: [
								{ slug: "name", label: "Name", type: "string" },
								// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately loose test input
								rates as never,
							],
						},
					],
				},
			},
		];
	}
	const rates = {
		slug: "rates",
		label: "Rates",
		type: "repeater",
		subFields: [{ slug: "unit", label: "Unit", type: "select", options: ["GB", "TB"] }],
	};

	it("accepts two nested levels", () => {
		expect(() => validateBlockFields(rateCards(rates))).not.toThrow();
	});

	it("rejects a third level at its type with the nesting limit", () => {
		expect(() =>
			validateBlockFields(
				rateCards({
					...rates,
					subFields: [{ slug: "tiers", label: "Tiers", type: "repeater", subFields: [] }],
				}),
			),
		).toThrow(
			"fields[0].validation.subFields[1].subFields[1].subFields[0].type: Repeaters can be nested only 2 levels deep",
		);
	});

	it("compares nested definitions instead of treating them as unchanged", () => {
		const narrowed = compareBlockFields(
			rateCards(rates),
			rateCards({ ...rates, subFields: [{ ...rates.subFields[0], options: ["GB"] }] }),
		);
		expect(narrowed.compatible).toBe(false);
		expect(narrowed.differences).toEqual([
			{
				path: "fields.categories.validation.subFields.products.validation.subFields.rates.validation.subFields.unit.validation.options",
				change: "allowed values changed",
				compatibility: "breaking",
			},
		]);

		const added = compareBlockFields(
			rateCards(rates),
			rateCards({
				...rates,
				subFields: [...rates.subFields, { slug: "note", label: "Note", type: "string" }],
			}),
		);
		expect(added.compatible).toBe(true);
		expect(added.differences).toHaveLength(1);
	});

	it("fingerprints a change inside a nested repeater", async () => {
		expect(await fingerprintBlockFields(rateCards({ ...rates, maxItems: 3 }))).not.toBe(
			await fingerprintBlockFields(rateCards(rates)),
		);
	});
});
