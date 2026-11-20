import { afterEach, beforeEach, expect, it } from "vitest";

import { createSchemaAccess } from "../../../src/plugins/context.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("plugin schema access: block types", (dialect) => {
	let ctx: DialectTestContext;
	let schema: SchemaRegistry;
	let blocks: BlockTypeRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		schema = new SchemaRegistry(ctx.db);
		blocks = new BlockTypeRegistry(ctx.db);
		await blocks.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [
				{ slug: "heading", label: "Heading", type: "string", required: true },
				{ slug: "link", label: "Link", type: "url" },
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: {
						subFields: [
							{ slug: "title", type: "string", label: "Title" },
							{ slug: "icon", type: "select", label: "Icon", options: ["a", "b"] },
						],
					},
				},
			],
		});
		await blocks.createBlockType({
			slug: "quote",
			label: "Quote",
			fields: [{ slug: "body", label: "Body", type: "text" }],
		});
		await schema.createCollection({ slug: "pages", label: "Pages" });
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero", "quote"] },
		});
		await schema.createField("pages", { slug: "summary", label: "Summary", type: "string" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("exposes each block type's versions and field types on blocks fields only", async () => {
		const pages = await createSchemaAccess(ctx.db).getCollection("pages");
		const layout = pages!.fields.find((field) => field.slug === "layout");
		const summary = pages!.fields.find((field) => field.slug === "summary");

		expect(summary).not.toHaveProperty("blockTypes");
		expect(layout?.blockTypes?.map((type) => type.slug)).toEqual(["hero", "quote"]);
		const hero = layout!.blockTypes![0]!;
		expect(hero).toMatchObject({ label: "Hero", currentVersion: 1 });
		expect(hero.versions).toHaveLength(1);
		expect(hero.versions[0]).toMatchObject({ version: 1, active: true });
		expect(hero.versions[0]!.fields.map((field) => [field.slug, field.type])).toEqual([
			["heading", "string"],
			["link", "url"],
			["items", "repeater"],
		]);
		expect(hero.versions[0]!.fields[2]!.validation?.subFields).toEqual([
			{ slug: "title", type: "string", label: "Title" },
			{ slug: "icon", type: "select", label: "Icon", options: ["a", "b"] },
		]);
		expect(JSON.parse(JSON.stringify(pages))).toEqual(pages);
		expect(hero).not.toHaveProperty("id");
		const stored = await blocks.getBlockType("hero");
		expect(hero.versions[0]?.fingerprint).toBe(stored!.versions[0]!.fingerprint);
	});

	it("keeps retired types and every retained version", async () => {
		const hero = await blocks.getBlockType("hero");
		const updated = await blocks.updateBlockType("hero", {
			expectedFingerprint: hero!.versions[0]!.fingerprint,
			fields: [{ slug: "heading", label: "Heading", type: "string" }],
			breaking: true,
		});
		await blocks.activateVersion("hero", 2, updated.versions[0]!.fingerprint);
		await schema.updateField("pages", "layout", { validation: { allowedTypes: ["quote"] } });

		const pages = await createSchemaAccess(ctx.db).getCollection("pages");
		const layout = pages!.fields.find((field) => field.slug === "layout")!;
		expect(layout.validation).toMatchObject({ allowedTypes: ["quote"], retiredTypes: ["hero"] });
		const retiredHero = layout.blockTypes!.find((type) => type.slug === "hero")!;
		expect(retiredHero.currentVersion).toBe(2);
		expect(retiredHero.versions.map((version) => [version.version, version.active])).toEqual([
			[1, false],
			[2, true],
		]);
	});

	it("omits a type that has no definition instead of failing the read", async () => {
		await ctx.db.deleteFrom("_emdash_block_types").where("slug", "=", "quote").execute();

		const access = createSchemaAccess(ctx.db);
		const fromGet = (await access.getCollection("pages"))!.fields.find(
			(field) => field.slug === "layout",
		)!;
		const fromList = (await access.listCollections())
			.find((collection) => collection.slug === "pages")!
			.fields.find((field) => field.slug === "layout")!;

		for (const layout of [fromGet, fromList]) {
			expect(layout.validation?.allowedTypes).toEqual(["hero", "quote"]);
			expect(layout.blockTypes?.map((type) => type.slug)).toEqual(["hero"]);
		}
	});

	it("returns no fields for versions whose stored field types this runtime can't read", async () => {
		const hero = await blocks.getBlockType("hero");
		await ctx.db
			.updateTable("_emdash_block_type_versions")
			.set({
				fields: JSON.stringify([{ slug: "layout", label: "Layout", type: "future_nested_type" }]),
			})
			.where("id", "=", hero!.versions[0]!.id)
			.execute();

		const pages = await createSchemaAccess(ctx.db).getCollection("pages");
		const version = pages!.fields.find((field) => field.slug === "layout")!.blockTypes![0]!
			.versions[0]!;
		expect(version.fields).toEqual([]);
		expect(version.unsupportedTypes).toEqual([
			{ type: "future_nested_type", path: "fields[0].type" },
		]);
	});

	it("listCollections reads block types once however many blocks fields exist", async () => {
		await schema.createCollection({ slug: "posts", label: "Posts" });
		await schema.createField("posts", {
			slug: "body_blocks",
			label: "Body",
			type: "blocks",
			validation: { allowedTypes: ["quote"] },
		});
		await schema.createField("pages", {
			slug: "footer",
			label: "Footer",
			type: "blocks",
			validation: { allowedTypes: ["quote"] },
		});

		const queried: string[] = [];
		const counting = ctx.db.withPlugin({
			transformQuery(args) {
				queried.push(JSON.stringify(args.node));
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		const collections = await createSchemaAccess(counting).listCollections();

		const blockTypeReads = queried.filter((query) => query.includes('"_emdash_block_types"'));
		expect(blockTypeReads).toHaveLength(1);
		const blocksFields = collections.flatMap((collection) =>
			collection.fields.filter((field) => field.type === "blocks"),
		);
		expect(blocksFields).toHaveLength(3);
		for (const field of blocksFields) expect(field.blockTypes?.length).toBeGreaterThan(0);
	});

	it("skips the block type read when no collection has a blocks field", async () => {
		await schema.deleteField("pages", "layout");

		const queried: string[] = [];
		const counting = ctx.db.withPlugin({
			transformQuery(args) {
				queried.push(JSON.stringify(args.node));
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		await createSchemaAccess(counting).listCollections();

		expect(queried.filter((query) => query.includes("_emdash_block_type"))).toHaveLength(0);
	});
});
