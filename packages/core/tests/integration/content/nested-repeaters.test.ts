import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { NestedRepeaterSubField } from "../../../src/schema/types.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const products: NestedRepeaterSubField = {
	slug: "products",
	type: "repeater",
	label: "Products",
	maxItems: 3,
	subFields: [
		{ slug: "name", type: "string", label: "Name", required: true },
		{
			slug: "rates",
			type: "repeater",
			label: "Rates",
			subFields: [
				{ slug: "price", type: "string", label: "Price", required: true },
				{ slug: "link", type: "url", label: "Link" },
				{ slug: "starts_at", type: "datetime", label: "Starts at" },
				{ slug: "icon", type: "image", label: "Icon" },
			],
		},
	],
};

const categorySubFields = [{ slug: "label", type: "string" as const, label: "Label" }, products];

describeEachDialect("nested repeaters", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let schema: SchemaRegistry;
	let mediaId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		schema = new SchemaRegistry(ctx.db);
		await schema.createCollection({ slug: "pages", label: "Pages" });
		await schema.createField("pages", { slug: "hero", label: "Hero", type: "image" });
		await schema.createField("pages", {
			slug: "categories",
			label: "Categories",
			type: "repeater",
			validation: { subFields: categorySubFields },
		});
		mediaId = ulid();
		await ctx.db
			.insertInto("media")
			.values({
				id: mediaId,
				filename: "icon.png",
				mime_type: "image/png",
				size: 100,
				width: 10,
				height: 10,
				alt: null,
				caption: null,
				storage_key: "icon.png",
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				status: "ready",
				author_id: null,
			})
			.execute();
		runtime = createTestRuntime(ctx.db);
		runtime.mediaProviders.set("local", createMediaProvider({ db: ctx.db }));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("stores two levels of rows and normalizes their values", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "pricing",
			data: {
				hero: mediaId,
				categories: [
					{
						label: "Storage",
						products: [
							{
								name: "R2",
								rates: [{ price: "$0.015", starts_at: "2026-01-15T10:00:00Z", icon: mediaId }],
							},
							{ name: "KV", rates: [] },
						],
					},
				],
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const categories = result.data.item.data.categories as Array<{
			products: Array<{ rates: Array<Record<string, unknown>> }>;
		}>;
		const rate = categories[0]!.products[0]!.rates[0]!;
		expect(rate.price).toBe("$0.015");
		expect(rate.starts_at).toBe("2026-01-15T10:00:00.000Z");
		expect(rate.icon).toEqual(result.data.item.data.hero);
		expect(rate.icon).toMatchObject({ id: mediaId, mimeType: "image/png" });
		expect(categories[0]!.products[1]).toEqual({ name: "KV", rates: [] });

		const reloaded = await runtime.handleContentGet("pages", result.data.item.id);
		expect(reloaded.success && reloaded.data.item.data.categories).toEqual(categories);
	});

	it("saves a blank nested image as null and leaves its sibling rows alone", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "blank-icon",
			data: {
				categories: [
					{
						products: [
							{
								name: "R2",
								rates: [
									{ price: "$1", icon: "" },
									{ price: "$2", icon: mediaId },
								],
							},
						],
					},
				],
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		const [category] = result.data.item.data.categories as Array<{
			products: Array<{ rates: Array<Record<string, unknown>> }>;
		}>;
		const [blank, filled] = category!.products[0]!.rates;
		expect(blank).toEqual({ price: "$1", icon: null });
		expect(filled).toMatchObject({ price: "$2", icon: { id: mediaId } });
	});

	it("reports invalid nested values at their full path", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "invalid",
			data: {
				categories: [
					{
						label: "Storage",
						products: [{ name: "R2", rates: [{ price: "" }, { price: "$1", link: 3 }] }],
					},
				],
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(result.error.details).toMatchObject({
			issues: expect.arrayContaining([
				expect.objectContaining({
					path: "categories.0.products.0.rates.0.price",
					code: "required",
				}),
				expect.objectContaining({ path: "categories.0.products.0.rates.1.link" }),
			]),
		});
	});

	it("applies a nested repeater's own item limits", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "too-many",
			data: {
				categories: [
					{ label: "Storage", products: ["a", "b", "c", "d"].map((name) => ({ name, rates: [] })) },
				],
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unsafe URLs in nested rows", async () => {
		const result = await runtime.handleContentCreate("pages", {
			slug: "unsafe",
			data: {
				categories: [
					{ products: [{ name: "R2", rates: [{ price: "$1", link: "javascript:alert(1)" }] }] },
				],
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toContain("categories.0.products.0.rates.0.link");
	});

	it("refuses a third level of nesting", async () => {
		await expect(
			schema.createField("pages", {
				slug: "too_deep",
				label: "Too deep",
				type: "repeater",
				validation: {
					subFields: [
						{
							...products,
							subFields: [
								{
									slug: "rates",
									type: "repeater",
									label: "Rates",
									subFields: [
										// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the types reject this on purpose
										{ slug: "tiers", type: "repeater", label: "Tiers", subFields: [] } as never,
									],
								},
							],
						},
					],
				},
			}),
		).rejects.toThrow("Repeaters can be nested only 2 levels deep");
	});

	it("refuses to turn a stored sub-field into a list or back", async () => {
		await expect(
			schema.updateField("pages", "categories", {
				validation: {
					subFields: [
						{ slug: "label", type: "repeater", label: "Label", subFields: products.subFields },
						products,
					],
				},
			}),
		).rejects.toMatchObject({ code: "FIELD_TYPE_CHANGE_REQUIRES_MIGRATION" });

		const added = await schema.updateField("pages", "categories", {
			validation: {
				subFields: [
					...categorySubFields,
					{
						slug: "notes",
						type: "repeater",
						label: "Notes",
						subFields: [{ slug: "text", type: "string", label: "Text" }],
					},
				],
			},
		});
		expect(added.validation?.subFields).toHaveLength(3);
	});

	it("validates nested rows inside a block type's repeater", async () => {
		await new BlockTypeRegistry(ctx.db).createBlockType({
			slug: "rate_cards",
			label: "Rate cards",
			fields: [
				{
					slug: "categories",
					label: "Categories",
					type: "repeater",
					validation: { subFields: categorySubFields },
				},
			],
		});
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["rate_cards"] },
		});
		const block = (rates: unknown[]) => ({
			_type: "rate_cards",
			categories: [{ label: "Storage", products: [{ name: "R2", rates }] }],
		});

		const valid = await runtime.handleContentCreate("pages", {
			slug: "blocks",
			data: { layout: [block([{ price: "$1", icon: { id: mediaId } }])] },
		});
		expect(valid.success).toBe(true);
		if (!valid.success) return;
		const [stored] = valid.data.item.data.layout as Array<{
			categories: Array<{ products: Array<{ rates: Array<Record<string, unknown>> }> }>;
		}>;
		expect(stored!.categories[0]!.products[0]!.rates[0]!.icon).toMatchObject({
			id: mediaId,
			mimeType: "image/png",
		});

		const invalid = await runtime.handleContentCreate("pages", {
			slug: "invalid-blocks",
			data: { layout: [block([{ price: 4 }])] },
		});
		expect(invalid.success).toBe(false);
	});
});
