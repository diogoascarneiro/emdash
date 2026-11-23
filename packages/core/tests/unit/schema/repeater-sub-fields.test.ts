import { describe, expect, it } from "vitest";

import { normalizeContentDatetimes } from "../../../src/datetime-normalization.js";
import { extractMediaUsageOccurrences } from "../../../src/media/usage/extractor.js";
import {
	findUnsupportedRepeaterSubFieldType,
	mapRepeaterValues,
	repeaterListTypeChanges,
	repeaterSubFieldIssues,
	repeaterSubFieldPaths,
} from "../../../src/schema/repeater-sub-fields.js";

const rates = {
	slug: "rates",
	type: "repeater",
	label: "Rates",
	subFields: [
		{ slug: "metric", type: "string", label: "Metric" },
		{ slug: "starts_at", type: "datetime", label: "Starts at" },
		{ slug: "icon", type: "image", label: "Icon" },
	],
};
const products = {
	slug: "products",
	type: "repeater",
	label: "Products",
	minItems: 0,
	maxItems: 10,
	subFields: [{ slug: "name", type: "string", label: "Name" }, rates],
};
const categorySubFields = [{ slug: "label", type: "string", label: "Label" }, products];

describe("repeaterSubFieldIssues", () => {
	it("accepts repeaters nested two levels inside a repeater field", () => {
		expect(repeaterSubFieldIssues(categorySubFields, "validation.subFields")).toEqual([]);
	});

	it("rejects a third level at the innermost repeater's type", () => {
		const tooDeep = {
			...rates,
			subFields: [{ slug: "tiers", type: "repeater", label: "Tiers", subFields: [] }],
		};
		expect(
			repeaterSubFieldIssues([{ ...products, subFields: [tooDeep] }], "validation.subFields"),
		).toEqual([
			{
				path: "validation.subFields[0].subFields[0].subFields[0].type",
				message: "Repeaters can be nested only 2 levels deep",
			},
		]);
	});

	it("rejects keys a nested repeater does not read instead of ignoring them", () => {
		expect(
			repeaterSubFieldIssues([{ ...rates, validation: { subFields: [] } }], "validation.subFields"),
		).toEqual([
			{
				path: "validation.subFields[0].validation",
				message: 'is not supported for type "repeater"',
			},
		]);
	});

	it("checks a nested repeater's limits and rows", () => {
		expect(
			repeaterSubFieldIssues(
				[{ ...rates, minItems: 3, maxItems: 2, subFields: [{ slug: "x", type: "nope" }] }],
				"s",
			).map((issue) => issue.path),
		).toEqual(["s[0].maxItems", "s[0].subFields[0].label", "s[0].subFields[0].type"]);
	});

	it("needs a nested repeater's maxItems to be at least 1, as a field's is", () => {
		const issues = repeaterSubFieldIssues([{ ...rates, maxItems: 0 }], "s");
		expect(issues).toEqual([{ path: "s[0].maxItems", message: "must be a positive integer" }]);
	});

	it("rejects a nested repeater that shares a slug with a single-value sibling, in either order", () => {
		const scalar = { slug: "rates", type: "string" };
		for (const subFields of [
			[scalar, rates],
			[rates, scalar],
		]) {
			expect(
				repeaterSubFieldIssues(subFields, "s", { lenientScalars: true }).map((issue) => issue.path),
			).toEqual(["s[1].slug"]);
		}
		expect(repeaterSubFieldIssues([scalar, { ...scalar }], "s", { lenientScalars: true })).toEqual(
			[],
		);
	});

	it("leaves single-value sub-fields alone when lenient, but not those inside a nested repeater", () => {
		const subFields = [
			{ slug: "Not A Slug", type: "string" },
			{ ...rates, subFields: [{ slug: "Bad Slug", type: "string", label: "Bad" }] },
		];
		expect(
			repeaterSubFieldIssues(subFields, "s", { lenientScalars: true }).map((issue) => issue.path),
		).toEqual(["s[1].subFields[0].slug"]);
	});
});

describe("findUnsupportedRepeaterSubFieldType", () => {
	it("reads two nested levels and fails closed on a third", () => {
		expect(findUnsupportedRepeaterSubFieldType(categorySubFields, "subFields")).toBeUndefined();
		const tooDeep = [
			{
				...products,
				subFields: [{ ...rates, subFields: [{ slug: "tiers", type: "repeater", subFields: [] }] }],
			},
		];
		expect(findUnsupportedRepeaterSubFieldType(tooDeep, "subFields")).toEqual({
			type: "repeater",
			path: "subFields[0].subFields[0].subFields[0].type",
		});
	});
});

describe("repeater value walkers", () => {
	it("lists dotted paths to a sub-field type through nested repeaters", () => {
		expect(repeaterSubFieldPaths(categorySubFields, "datetime")).toEqual([
			"products.rates.starts_at",
		]);
		expect(repeaterSubFieldPaths(categorySubFields, "string")).toEqual([
			"label",
			"products.name",
			"products.rates.metric",
		]);
	});

	it("maps nested values copy-on-write and skips values that are not lists", () => {
		const rows = [
			{ label: "Storage", products: [{ name: "R2", rates: [{ metric: "a" }, { metric: "b" }] }] },
			{ label: "Legacy", products: "" },
		];
		const unchanged = mapRepeaterValues(rows, "products.rates.metric", (value) => value);
		expect(unchanged).toBe(rows);

		const mapped = mapRepeaterValues(rows, "products.rates.metric", (value, location) =>
			value === "b" ? location.join(".") : value,
		);
		expect(mapped).toEqual([
			{
				label: "Storage",
				products: [
					{ name: "R2", rates: [{ metric: "a" }, { metric: "0.products.0.rates.1.metric" }] },
				],
			},
			{ label: "Legacy", products: "" },
		]);
		expect(mapped[1]).toBe(rows[1]);
		expect(rows[0]!.products).toEqual([{ name: "R2", rates: [{ metric: "a" }, { metric: "b" }] }]);
	});

	it("normalizes datetimes in nested rows", () => {
		const normalized = normalizeContentDatetimes(
			{ categories: [{ products: [{ rates: [{ starts_at: "2026-01-15T10:00" }] }] }] },
			[
				{
					slug: "categories",
					type: "repeater",
					datetimeSubFields: repeaterSubFieldPaths(categorySubFields, "datetime"),
				},
			],
			"Europe/London",
		);
		expect(normalized.value).toEqual({
			categories: [{ products: [{ rates: [{ starts_at: "2026-01-15T10:00:00.000Z" }] }] }],
		});
		expect(normalized.changedCount).toBe(1);
	});

	it("records media used in nested rows with their full path", () => {
		const occurrences = extractMediaUsageOccurrences({
			fields: [
				{
					slug: "categories",
					type: "repeater",
					validation: {
						subFields: [
							{
								slug: "products",
								type: "repeater",
								subFields: [
									{
										slug: "rates",
										type: "repeater",
										subFields: [{ slug: "icon", type: "image" }],
									},
								],
							},
						],
					},
				},
			],
			data: { categories: [{ products: [{ rates: [{}, { icon: "media-1" }] }] }] },
		});
		expect(occurrences.map((occurrence) => occurrence.fieldPath)).toEqual([
			"categories[0].products[0].rates[1].icon",
		]);
		expect(occurrences[0]).toMatchObject({ fieldSlug: "categories", mediaId: "media-1" });
	});
});

describe("repeaterListTypeChanges", () => {
	it("finds sub-fields that change between a single value and a list", () => {
		const before = [{ slug: "label", type: "string" }, products];
		expect(repeaterListTypeChanges(before, [...before])).toEqual([]);
		expect(repeaterListTypeChanges(before, [{ ...before[0], type: "text" }, products])).toEqual([]);
		expect(
			repeaterListTypeChanges(before, [
				{ slug: "label", type: "repeater", subFields: [] },
				{
					...products,
					subFields: [
						{ slug: "name", type: "string" },
						{ ...rates, type: "string" },
					],
				},
			]),
		).toEqual(["validation.subFields.label", "validation.subFields.products.subFields.rates"]);
	});
});
